/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, PluginNativeEvents, StartAt } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { onceReady } from "@webpack";
import {
    Alerts,
    ApplicationStreamingStore,
    Button,
    Checkbox,
    Menu,
    Modal,
    openModal,
    SearchableSelect,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "@webpack/common";

import * as orchestration from "./nativeOrchestration";

const logger = new Logger("PatchcordAppAudio");

const Native = VencordNative.pluginHelpers.PatchcordAppAudio as unknown as PluginNative<typeof import("./native")> & PluginNativeEvents;

const settings = definePluginSettings({
    rememberLastSelection: {
        type: OptionType.BOOLEAN,
        description: "Pre-select the app you picked last time when the screenshare picker opens again.",
        default: true,
    },
    askEveryTime: {
        type: OptionType.BOOLEAN,
        description: "Show the audio-source picker every time you share. Disable to always use your last choice without asking.",
        default: true,
    },
    onlySpeakers: {
        type: OptionType.BOOLEAN,
        description: "When sharing multiple/entire-system audio, only include apps whose audio currently reaches a speaker.",
        default: true,
    },
    onlyDefaultSpeakers: {
        type: OptionType.BOOLEAN,
        description: "When sharing multiple/entire-system audio, only include apps playing to your default speakers.",
        default: true,
    },
    ignoreInputMedia: {
        type: OptionType.BOOLEAN,
        description: "Exclude nodes that are themselves capturing audio (e.g. other apps' recording streams).",
        default: true,
    },
    ignoreVirtual: {
        type: OptionType.BOOLEAN,
        description: "Exclude virtual nodes, such as other apps' own loopbacks.",
        default: false,
    },
    ignoreDevices: {
        type: OptionType.BOOLEAN,
        description: "Exclude physical devices (microphones/speakers) from the picker.",
        default: true,
    },
    deviceSelect: {
        type: OptionType.BOOLEAN,
        description: "Allow picking a physical input/output device (e.g. a microphone) instead of an app. Requires \"Exclude physical devices\" to be off.",
        default: false,
    },
    groupByApplication: {
        type: OptionType.BOOLEAN,
        description:
            "Selecting one node from an app selects/shares all of that app's audio nodes (e.g. every open " +
            "Firefox tab, not just the one you clicked), and any new node the app opens later while you're " +
            "already sharing it is picked up automatically.",
        default: false,
    },
    // Tracks the user's answer to the discord-capture-shim install
    // prompt (see maybePromptDiscordCaptureShimInstall below) so they
    // aren't re-asked on every launch after declining once. Not shown as
    // a visible toggle in the settings UI (hidden) -- it's consent
    // bookkeeping, not a feature switch; the actual re-installable
    // action is the "Install audio capture shim" button below, which
    // works regardless of what this is set to.
    discordCaptureShimPromptDeclined: {
        type: OptionType.BOOLEAN,
        description: "internal: user previously declined the discord-capture-shim install prompt",
        default: false,
        hidden: true,
    },
    // Set the first time installShim() ever succeeds, and never
    // cleared -- distinct from discordCaptureShimPromptDeclined, which
    // only means "never asked to install it at all". A Discord
    // auto-update can silently overwrite discord_voice.node and wipe an
    // already-applied patch; when that happens getShimStatus() reports
    // alreadyInstalled: false again on the next launch even though this
    // stays true, which is exactly the signal
    // maybePromptDiscordCaptureShimInstall uses to show a distinct
    // "repatch needed" prompt instead of silently doing nothing (which
    // discordCaptureShimPromptDeclined being true would otherwise cause
    // for a user who explicitly opted in previously).
    discordCaptureShimEverInstalled: {
        type: OptionType.BOOLEAN,
        description: "internal: discord-capture-shim has been successfully installed at least once",
        default: false,
        hidden: true,
    },
    installDiscordCaptureShim: {
        type: OptionType.COMPONENT,
        description:
            "Downloads and installs discord-capture-shim, a small native component required for " +
            "per-app audio sharing to actually work (without it, Discord shares every detected app's audio " +
            "at once, same as its stock behavior). Patches discord_voice.node in your current Discord " +
            "install; keeps a backup and can be undone with the button below.",
        component: () => <InstallShimButton />,
    },
    restoreDiscordCaptureShim: {
        type: OptionType.COMPONENT,
        description: "Restores discord_voice.node to its original, unpatched state (undoes the button above).",
        component: () => <RestoreShimButton />,
    },
});

interface ShareableNode {
    id: number;
    displayName: string;
    applicationName: string | null;
    nodeName: string | null;
    processId: number | null;
    isDevice: boolean;
    mediaClass: string | null;
    isVirtual: boolean;
    binary?: string | null;
    mediaName?: string | null;
}

interface RouteFilter {
    onlySpeakers?: boolean;
    onlyDefaultSpeakers?: boolean;
    ignoreDevices?: boolean;
    ignoreVirtual?: boolean;
    ignoreInputMedia?: boolean;
}

function currentRouteFilter(): RouteFilter {
    return {
        onlySpeakers: settings.store.onlySpeakers,
        onlyDefaultSpeakers: settings.store.onlyDefaultSpeakers,
        ignoreDevices: settings.store.ignoreDevices,
        ignoreVirtual: settings.store.ignoreVirtual,
        ignoreInputMedia: settings.store.ignoreInputMedia,
    };
}

interface ScreencastHint {
    desktopFileId: string;
    hint: string;
}

/**
 * Best-effort match of a candidate audio node against a KWin screencast
 * hint (see native.ts / patchcordClient.d.ts for the mechanism). Plain
 * case-insensitive substring match in both directions against the fields
 * most likely to carry an app's identity, mirroring how loosely a human
 * would eyeball "does this audio app look like the shared window".
 */
function nodeMatchesHint(node: ShareableNode, hint: ScreencastHint): boolean {
    const needle = hint.hint.toLowerCase();
    const haystacks = [node.applicationName, node.nodeName, node.binary, node.displayName]
        .filter((v): v is string => !!v)
        .map(v => v.toLowerCase());
    return haystacks.some(h => h.includes(needle) || needle.includes(h));
}

/**
 * Ensures patchcord is running, prompting for consent (same
 * per-asset download-consent dialog installShim/restoreShim use) if
 * the main patchcord binary itself needs it -- without this,
 * ensurePatchcord's `not_consented` result was previously swallowed
 * silently by every caller (fetchShareableNodes/fetchScreencastHint
 * both just caught it and returned an empty result), leaving the
 * picker permanently empty with no visible reason and no way to ever
 * grant consent for the main binary at all.
 *
 * Callers (fetchShareableNodes + fetchScreencastHint) run concurrently
 * via Promise.all, so this caches its own in-flight Promise the same
 * way orchestration.ensurePatchcord does -- without it, both callers
 * would independently show their own consent Alerts.show dialog at
 * once.
 */
let ensurePatchcordWithConsentInFlight: Promise<orchestration.EnsurePatchcordResult> | null = null;
function ensurePatchcordWithConsent(): Promise<orchestration.EnsurePatchcordResult> {
    if (ensurePatchcordWithConsentInFlight) return ensurePatchcordWithConsentInFlight;

    ensurePatchcordWithConsentInFlight = (async () => {
        try {
            let result = await orchestration.ensurePatchcord(Native);
            result = await promptConsentAndRetry(
                result,
                "PatchcordAppAudio needs to download and run patchcord, the native helper that talks to " +
                "PipeWire to list and route audio sources.",
                () => orchestration.ensurePatchcord(Native)
            );
            if (!result.ok && (result as any).reason !== "not_consented") {
                logger.error("Failed to start patchcord:", (result as any).reason, (result as any).message);
            }
            return result;
        } finally {
            ensurePatchcordWithConsentInFlight = null;
        }
    })();
    return ensurePatchcordWithConsentInFlight;
}

async function fetchShareableNodes(includeDevices = false): Promise<ShareableNode[]> {
    try {
        const ensured = await ensurePatchcordWithConsent();
        if (!ensured.ok) return [];
        return await orchestration.listShareableNodes(Native, includeDevices);
    } catch (e) {
        logger.error("Failed to list shareable nodes", e);
        return [];
    }
}

async function fetchScreencastHint(): Promise<ScreencastHint | null> {
    try {
        const ensured = await ensurePatchcordWithConsent();
        if (!ensured.ok) return null;
        return await orchestration.findScreencastHint(Native);
    } catch (e) {
        logger.warn("Failed to fetch screencast hint (non-fatal)", e);
        return null;
    }
}

let lastSelectedNodeNames: string[] = [];

/**
 * The node keys currently actually routed into `discord_capture` (or
 * empty if none), independent of `lastSelectedNodeNames` -- which only
 * tracks a *remembered* selection and is itself gated behind the
 * "remember last selection between shares" setting. This one is always
 * kept in sync with reality regardless of that setting, purely so
 * reopening the picker mid-stream (see `reopenPickerMidStream`) can show
 * what's actually currently selected rather than an empty list whenever
 * the user has that unrelated setting turned off.
 */
let activeSelectionNodeNames: string[] = [];

/**
 * Overall picker mode, mirroring Vesktop's "None" / single-or-multi-app /
 * "Entire System" distinction. "apps" covers both a single app and a
 * multi-app selection -- the underlying list widget always supports
 * multi-select, there's no separate UI mode for "just one app".
 */
type PickerMode = "none" | "apps" | "system";

/**
 * Result of the picker: which nodes to actually pass to patchcord's
 * routeNodes, computed according to the chosen PickerMode. "system" mode
 * resolves to "every currently-known audio node except the excluded
 * ones" at picker-close time (not continuously -- patchcord's routeNodes
 * takes an explicit id list, there's no "all except" primitive on the
 * Rust side, so this is where that set difference is computed) rather
 * than every node open-endedly for the stream's whole lifetime.
 */
interface PickerResult {
    mode: PickerMode;
    nodes: ShareableNode[];
    /**
     * True only when the picker was dismissed via Escape -- distinct from
     * an explicit "Skip (normal audio)" click, which also resolves with
     * `mode: "none"` but is NOT cancelled. Callers reopening this picker
     * mid-stream (see index.tsx's "Change apps..." button) need this
     * distinction: Escape means "never mind, leave my current selection
     * alone", while Skip is a deliberate "stop sharing any app's audio"
     * request. The very first picker (shown when a screenshare starts)
     * doesn't need the distinction -- there's no prior selection to
     * preserve yet, so both cases already correctly mean "share normal
     * system audio" there.
     */
    cancelled: boolean;
}

/**
 * Unique key for one node in the picker's selection state.
 *
 * Falls back to plain `node.nodeName` when present (e.g. "Firefox")
 * would NOT be unique -- every tab/window an app opens shares the exact
 * same `node.name`, so two live Firefox tabs would collide on the
 * identical key, silently merging them into a single
 * selectable/toggleable entry. `node.id` is `ShareableNode.id`, the live
 * PipeWire registry id -- guaranteed unique among currently-live nodes,
 * which is exactly the uniqueness this key needs. It does change across
 * process restarts (a relaunched Firefox gets a fresh id), which is why
 * `nodeName` is prepended for the "remember my last selection between
 * shares" feature to have a chance of surviving that in the common case
 * where the same node.name only ever resolves to one live id at a time.
 */
function nodeKey(node: ShareableNode): string {
    return `${node.nodeName ?? node.displayName}#${node.id}`;
}

/**
 * Human-facing label for one node in the picker list. `displayName` is
 * usually just the app's own name (e.g. "Firefox") -- Discord/PipeWire
 * only exposes the more specific detail (which tab, which track) via
 * `media_name`, which is otherwise dropped entirely. Appending it in
 * parens when it's actually more specific than the plain app name (not
 * identical, not empty) turns "Firefox" into "Firefox (Artcore/DnB
 * Playlist - YouTube)" so multiple tabs/windows of the same app are
 * distinguishable in the list instead of showing up as several
 * identically-labelled "Firefox" entries.
 */
function nodeLabel(node: ShareableNode): string {
    const detail = node.mediaName?.trim();
    if (!detail || detail === node.displayName || detail === node.applicationName) {
        return node.displayName;
    }
    return `${node.displayName} (${detail})`;
}

interface PickerOption {
    value: string;
    label: string;
    disabled?: boolean;
    node: ShareableNode | null;
}

function toOptions(list: ShareableNode[]): PickerOption[] {
    const opts: PickerOption[] = list.map(node => ({ value: nodeKey(node), label: nodeLabel(node), node }));
    if (list.length === 0) {
        opts.push({
            value: "__empty__",
            label: "No matching audio sources found -- try Refresh once something is playing sound",
            disabled: true,
            node: null,
        });
    }
    return opts;
}

/**
 * The audio-picker, rendered inside a real Discord `<Modal>` instead of
 * hand-built DOM -- gets Discord's actual modal chrome, animation,
 * focus-trap, and escape-to-close for free, and the
 * `SearchableSelect`/`Checkbox` components automatically track the
 * user's live theme/QuickCSS the same way any of Discord's own dialogs
 * do.
 */
function AudioPickerModal({
    modalProps,
    initialNodes,
    initialHint,
    initialMode,
    onFinish,
}: {
    modalProps: RenderModalProps;
    initialNodes: ShareableNode[];
    initialHint: ScreencastHint | null;
    initialMode: PickerMode;
    onFinish: (result: PickerResult) => void;
}) {
    const [nodes, setNodes] = useState(initialNodes);
    const [hint, setHint] = useState(initialHint);
    const [mode, setMode] = useState<PickerMode>(initialMode);
    const [filterActive, setFilterActive] = useState(initialHint != null);
    const [refreshing, setRefreshing] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const isFirstRenderRef = useRef(true);
    const settingsSnapshot = settings.use([
        "deviceSelect", "ignoreDevices", "groupByApplication",
        "onlySpeakers", "onlyDefaultSpeakers", "ignoreInputMedia", "ignoreVirtual",
    ]);

    const shareableFor = (list: ShareableNode[]) =>
        list.filter(n => !n.isVirtual && (settingsSnapshot.deviceSelect && !settingsSnapshot.ignoreDevices ? true : !n.isDevice));

    function currentAppList(): ShareableNode[] {
        const shareable = shareableFor(nodes);
        const matched = hint ? shareable.filter(n => nodeMatchesHint(n, hint!)) : [];
        return filterActive && matched.length > 0 ? matched : shareable;
    }

    function preselectedValues(list: ShareableNode[]): Set<string> {
        // The very first render, when reopened mid-stream with an active
        // selection (initialMode === "apps"): preselect exactly what's
        // actually routed right now, regardless of the separate
        // "remember last selection" setting -- see
        // activeSelectionNodeNames's own doc comment for why that
        // setting shouldn't gate this. Only applies once; any subsequent
        // render in this same modal (mode switches, Refresh) falls
        // through to the normal lastSelectedNodeNames-based behavior
        // below, unchanged from before.
        if (isFirstRenderRef.current && initialMode === "apps" && activeSelectionNodeNames.length > 0) {
            const keys = new Set(list.map(nodeKey));
            return new Set(activeSelectionNodeNames.filter(n => keys.has(n)));
        }
        if (!settings.store.rememberLastSelection || lastSelectedNodeNames.length === 0) return new Set();
        const keys = new Set(list.map(nodeKey));
        return new Set(lastSelectedNodeNames.filter(n => keys.has(n)));
    }

    const listForMode = mode === "apps" ? currentAppList() : shareableFor(nodes);
    const options = useMemo(() => toOptions(listForMode), [listForMode]);
    const [selectedValues, setSelectedValues] = useState<string[]>(() => [...preselectedValues(listForMode)]);

    // Re-derive the preselection whenever the mode (or the underlying
    // node list) changes -- mirrors the old imperative renderList()'s
    // multi.setOptions(..., preselected, ...) call on every mode switch
    // and Refresh.
    useEffect(() => {
        setSelectedValues([...preselectedValues(listForMode)]);
        isFirstRenderRef.current = false;
    }, [mode, nodes]);

    function computeResultNodes(): ShareableNode[] {
        if (mode === "none") return [];
        const selectedNodes = options.filter(o => selectedValues.includes(o.value) && o.node).map(o => o.node!);
        if (mode === "apps") return selectedNodes;
        // system: every currently-known shareable node minus the
        // excluded selection. Filtering (onlySpeakers etc.) is applied
        // server-side by patchcord's routeNodes itself, so this is
        // deliberately the *unfiltered* candidate set, not pre-trimmed
        // here -- see currentRouteFilter().
        const excludedKeys = new Set(selectedNodes.map(nodeKey));
        return shareableFor(nodes).filter(n => !excludedKeys.has(nodeKey(n)));
    }

    function finish(cancelled = false) {
        const resultNodes = computeResultNodes();
        if (!cancelled) {
            // Cancel (Escape) must never touch either of these -- mode
            // was already forced to "none" by the cancel handler purely
            // to make computeResultNodes() return an empty result for
            // the (unused, since cancelled=true) `nodes` field, not
            // because anything should actually change.
            activeSelectionNodeNames = mode === "apps" ? resultNodes.map(nodeKey) : [];
            if (settings.store.rememberLastSelection) {
                lastSelectedNodeNames = activeSelectionNodeNames;
            }
        }
        onFinish({ mode, nodes: resultNodes, cancelled });
        modalProps.onClose();
    }

    async function handleRefresh() {
        if (refreshing) return;
        setRefreshing(true);
        try {
            const includeDevices = settingsSnapshot.deviceSelect && !settingsSnapshot.ignoreDevices;
            const [newNodes, newHint] = await Promise.all([
                fetchShareableNodes(includeDevices),
                fetchScreencastHint(),
            ]);
            setNodes(newNodes);
            setHint(newHint);
            if (newHint == null) setFilterActive(false);
        } finally {
            setRefreshing(false);
        }
    }

    let description: string;
    if (mode === "none") {
        description = "Discord will share its normal (whole-system default) audio, same as without this plugin.";
    } else if (mode === "apps") {
        description =
            "Route only the selected apps' audio into this screenshare instead of your whole system's " +
            "default output. Pick one or more.";
    } else {
        description =
            "Route your whole system's default audio into this screenshare, except the apps excluded below " +
            "(matches Discord's usual \"Stream With Audio\" behavior, but lets you leave specific apps out).";
    }

    const shareableForHint = shareableFor(nodes);
    const matchedForHint = hint ? shareableForHint.filter(n => nodeMatchesHint(n, hint!)) : [];
    const showHintNotice = mode === "apps" && !!hint;

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Share app audio? (patchcord)"
            actions={[
                { text: "Skip (normal audio)", variant: "secondary", onClick: () => { setMode("none"); finish(); } },
                { text: "Start Sharing", variant: "primary", onClick: () => finish(false) },
            ]}
        >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.PRIMARY}
                    look={Button.Looks.FILLED}
                    disabled={refreshing}
                    onClick={() => { void handleRefresh(); }}
                >
                    {refreshing ? "Refreshing…" : "↻ Refresh"}
                </Button>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {([
                    { value: "none", label: "None" },
                    { value: "apps", label: "Specific Apps" },
                    { value: "system", label: "Entire System" },
                ] as { value: PickerMode; label: string; }[]).map(m => (
                    <Button
                        key={m.value}
                        style={{ flex: 1 }}
                        color={mode === m.value ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                        onClick={() => setMode(m.value)}
                    >
                        {m.label}
                    </Button>
                ))}
            </div>

            <Paragraph style={{ marginBottom: 12 }}>{description}</Paragraph>

            {showHintNotice && (
                <Paragraph style={{ marginBottom: 8 }}>
                    {filterActive && matchedForHint.length > 0 ? (
                        <>
                            Filtered to apps matching your shared window ("{hint!.hint}").{" "}
                            <a href="#" onClick={e => { e.preventDefault(); setFilterActive(false); }}>
                                Show all apps instead
                            </a>
                        </>
                    ) : matchedForHint.length > 0 ? (
                        <>
                            Not filtering by shared window ("{hint!.hint}" match available).{" "}
                            <a href="#" onClick={e => { e.preventDefault(); setFilterActive(true); }}>
                                Filter to likely match
                            </a>
                        </>
                    ) : (
                        `Couldn't match any audio app to your shared window ("${hint!.hint}").`
                    )}
                </Paragraph>
            )}

            {mode !== "none" && (
                <SearchableSelect
                    placeholder={mode === "apps" ? "Select apps to share…" : "Exclude apps (optional)…"}
                    multi
                    options={options}
                    value={selectedValues}
                    onChange={v => setSelectedValues(v ?? [])}
                    closeOnSelect={false}
                />
            )}

            {mode === "apps" && (
                <div style={{ marginTop: 10 }}>
                    <Checkbox
                        value={!!settings.store.groupByApplication}
                        onChange={(_, v) => { settings.store.groupByApplication = v; }}
                    >
                        Share all tabs/windows of each picked app (not just the one selected)
                    </Checkbox>
                </div>
            )}

            <a
                href="#"
                style={{ display: "inline-block", fontSize: 12, marginTop: 12 }}
                onClick={e => { e.preventDefault(); setAdvancedOpen(!advancedOpen); }}
            >
                Advanced audio filters {advancedOpen ? "▴" : "▾"}
            </a>

            {advancedOpen && (
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                    {([
                        { key: "onlySpeakers", label: "Only Speakers" },
                        { key: "onlyDefaultSpeakers", label: "Only Default Speakers" },
                        { key: "ignoreInputMedia", label: "Ignore Inputs" },
                        { key: "ignoreVirtual", label: "Ignore Virtual" },
                        { key: "ignoreDevices", label: "Ignore Devices" },
                        { key: "deviceSelect", label: "Device Selection" },
                    ] as { key: "onlySpeakers" | "onlyDefaultSpeakers" | "ignoreInputMedia" | "ignoreVirtual" | "ignoreDevices" | "deviceSelect"; label: string; }[]).map(t => (
                        <Checkbox
                            key={t.key}
                            value={!!settings.store[t.key]}
                            onChange={(_, v) => { (settings.store as any)[t.key] = v; }}
                        >
                            {t.label}
                        </Checkbox>
                    ))}
                </div>
            )}
        </Modal>
    );
}

/**
 * Opens a real Discord `<Modal>` (via `openModal`) instead of a
 * hand-built DOM overlay -- same native chrome, animation, focus-trap,
 * and escape-to-close as every one of Discord's own dialogs, and it
 * automatically matches the user's live theme/QuickCSS instead of
 * hardcoding CSS variable references. Resolves with the chosen nodes, or
 * an empty result for "use normal system audio".
 */
function showAudioPickerModal(
    initialNodes: ShareableNode[],
    initialHint: ScreencastHint | null,
    initialMode: PickerMode = "none"
): Promise<PickerResult> {
    logger.info("showAudioPickerModal called with", initialNodes.length, "nodes, hint =", initialHint);
    return new Promise(resolve => {
        let resolved = false;
        function finishOnce(result: PickerResult) {
            if (resolved) return;
            resolved = true;
            resolve(result);
        }

        openModal(modalProps => (
            <AudioPickerModal
                modalProps={modalProps}
                initialNodes={initialNodes}
                initialHint={initialHint}
                initialMode={initialMode}
                onFinish={finishOnce}
            />
        ), {
            onCloseRequest: () => {
                // Escape (or clicking the backdrop): leave the current
                // selection alone, distinct from an explicit "Skip"
                // click -- see PickerResult.cancelled's own doc comment.
                finishOnce({ mode: "none", nodes: [], cancelled: true });
            },
        });
    });
}

/**
 * Actually applies app-audio routing once the user has picked one or more
 * nodes from the picker modal: links those nodes' audio directly into
 * every live `discord_capture` node -- Discord's own native per-app
 * screenshare-audio capture, the actual audio path "Stream With Audio"
 * uses. This requires
 * `discord-capture-shim` (a separate LD_PRELOAD native library, not part
 * of this plugin -- see its own README) to be installed, which strips
 * Discord's own auto-linking properties from each `discord_capture`
 * stream before it's created; without the shim, this call still
 * succeeds and still creates the requested links, but Discord's own
 * auto-linking keeps adding every other detected app's link right
 * alongside them, so nothing appears to change from the user's
 * perspective.
 *
 * `filter` is patchcord's RouteFilter (onlySpeakers/onlyDefaultSpeakers/
 * ignoreDevices/ignoreVirtual/ignoreInputMedia -- see currentRouteFilter);
 * applied server-side by patchcord's own setDiscordCaptureTargets (the
 * identical should_link decision routeNodes uses), not pre-filtered
 * here, so "Entire System" mode's already broad candidate list gets
 * narrowed down correctly regardless of exactly which nodes were passed
 * in.
 */
async function applyAppAudioRouting(nodes: ShareableNode[], filter: RouteFilter): Promise<(() => void) | null> {
    logger.info("Applying app-audio routing for nodes:", nodes.map(n => `${n.id}:${n.displayName}`), "filter:", filter);
    try {
        // "Group by application" only makes sense for a specific-apps
        // selection -- "Entire System" already includes every node from
        // every app (minus the excluded ones) whether grouping is on or
        // not, so there's nothing extra to expand there.
        const groupApplicationNames = settings.store.groupByApplication
            ? [...new Set(nodes.map(n => n.applicationName).filter((v): v is string => !!v))]
            : undefined;

        const ok = await orchestration.startAppAudio(Native, nodes.map(n => n.id), filter, groupApplicationNames);
        if (!ok) {
            logger.warn("patchcord failed to start app audio routing.");
            return null;
        }

        logger.info(`App audio routing active for ${nodes.length} node(s) via discord_capture direct link.`);
        return () => {
            orchestration.stopAppAudio().catch(() => {});
        };
    } catch (e) {
        logger.error("Failed to apply app-audio routing via patchcord", e);
        return null;
    }
}

/**
 * Reopens the same picker modal used for the initial share, applies
 * whatever new selection the user makes via the same
 * `applyAppAudioRouting` path (which itself just calls
 * `setDiscordCaptureTargets` again -- patchcord's own
 * `sync_discord_capture_links` already tears down any links to
 * newly-deselected apps and adds links for newly-selected ones, so there
 * is no separate "update" vs "start" codepath needed on the Rust side).
 * No picker-ack involved here at all -- that mechanism only exists to
 * hold up Discord's own stream *start*, which already happened long
 * before this button could even appear.
 */
async function reopenPickerMidStream(triggerBtn?: HTMLButtonElement) {
    if (triggerBtn) triggerBtn.disabled = true;
    try {
        const includeDevices = settings.store.deviceSelect && !settings.store.ignoreDevices;
        const [nodes, hint] = await Promise.all([fetchShareableNodes(includeDevices), fetchScreencastHint()]);
        // Reopen already showing the currently-active selection (rather
        // than always resetting to "None") when there is one --
        // lastSelectedNodeNames already holds it regardless of the
        // separate "remember last selection between shares" setting
        // (that setting only controls whether it's *used* the next time
        // a share starts fresh, not whether it's tracked at all).
        const initialMode: PickerMode = lastSelectedNodeNames.length > 0 ? "apps" : "none";
        const pick = await showAudioPickerModal(nodes, hint, initialMode);
        logger.info("Mid-stream picker resolved with:", pick.mode, pick.nodes.map(n => n.displayName), "cancelled =", pick.cancelled);

        if (pick.cancelled) {
            // User hit Escape: leave the current routing exactly as it
            // was, don't touch cleanupCurrentRouting, and the button
            // stays visible for next time (it was never removed).
            return;
        }

        if (cleanupCurrentRouting) {
            try {
                cleanupCurrentRouting();
            } catch { /* best effort */ }
            cleanupCurrentRouting = null;
        }

        if (pick.nodes.length === 0) {
            return;
        }

        cleanupCurrentRouting = await applyAppAudioRouting(pick.nodes, currentRouteFilter());
    } catch (e) {
        logger.error("Failed to change apps mid-stream", e);
    } finally {
        if (triggerBtn) triggerBtn.disabled = false;
    }
}

// --- discord_voice native screenshare-picker hook ---------------------------

/**
 * Discord's native Linux desktop client, under Wayland
 * (features.declareSupported('native_screenshare_picker')), uses a
 * completely separate, portal-native picker API for screenshare --
 * setNativeDesktopVideoSourcePickerActive / presentNativeScreenSharePicker
 * / setNativeScreenSharePickerCallbacks -- rather than the per-connection
 * setDesktopSourceWithOptions method or the standard Web
 * getDisplayMedia() API (confirmed via native discord_voice.node C++
 * symbols and live testing of two earlier, now-abandoned interception
 * attempts on both of those).
 *
 * setNativeScreenSharePickerCallbacks itself can't be patched from here
 * (renderer/main-world code): DiscordNative.nativeModules.requireModule(name),
 * called across Electron's context bridge, returns a *fresh
 * structured-clone* of the underlying native-module object on every
 * single call -- confirmed live (`a = requireModule(...); b =
 * requireModule(...); a === b` -> false, and mutating a property on `a`
 * is invisible to `b` or to Discord's own webpack code, which gets its
 * own separate clone too). This is an Electron context-bridge design
 * constraint, not something any amount of monkey-patching in this file
 * can work around.
 *
 * The actual patch now lives in this plugin's own preload.ts (a
 * top-level plugin preload module, run via Equicord core's generic
 * per-plugin preload mechanism -- see src/pluginPreloads.ts), applied to
 * the real, single, pre-bridge DiscordNative object before
 * contextBridge.exposeInMainWorld ever clones it out. That preload-side
 * patch dispatches a plain `window` CustomEvent
 * (DiscordNativePatchEvents.ScreenSharePickerResult) whenever the real
 * native picker completes -- ordinary DOM events aren't subject to
 * contextBridge cloning at all, since the DOM/window is one shared tree
 * between the isolated preload context and the main world on the same
 * page. We just listen for it here.
 */
const SCREEN_SHARE_PICKER_RESULT_EVENT = "equicord:discordVoice:screenSharePickerResult";
const SCREEN_SHARE_PICKER_ACK_EVENT = "equicord:discordVoice:screenSharePickerAck";
const DESKTOP_SOURCE_ENDED_EVENT = "equicord:discordVoice:desktopSourceEnded";

let cleanupCurrentRouting: (() => void) | null = null;
let pickerListenerInstalled = false;

/**
 * Acks the preload-side patch's pending "update" callback hold (see
 * preload.ts's waitForPickerAck) so Discord's real stream-start
 * proceeds. Always called exactly once per "update" event, whether or not
 * an app-audio target was actually selected -- the ack just means "our
 * decision is made", not "audio routing succeeded".
 */
function ackScreenSharePicker() {
    window.dispatchEvent(new CustomEvent(SCREEN_SHARE_PICKER_ACK_EVENT));
}

async function handleScreenSharePickerResult(kind: string, args: any[]) {
    logger.info(`Native screenshare picker callback fired: kind=${kind}`, args);

    if (kind !== "update") {
        // "cancel" or "error": nothing to offer a picker for. No ack
        // needed either -- only "update" is ever held waiting.
        logger.info(`Picker callback was "${kind}", not "update"; skipping app-audio picker.`);
        return;
    }

    logger.info("Update callback fired; proceeding to fetch nodes and show picker modal.");

    try {
        let resultNodes: ShareableNode[] = [];
        logger.info("Fetching shareable nodes and screencast hint...");
        const includeDevices = settings.store.deviceSelect && !settings.store.ignoreDevices;
        const [nodes, hint] = await Promise.all([fetchShareableNodes(includeDevices), fetchScreencastHint()]);
        logger.info("Fetched", nodes.length, "shareable nodes; hint =", hint, "askEveryTime =", settings.store.askEveryTime);

        if (settings.store.askEveryTime) {
            const pick = await showAudioPickerModal(nodes, hint);
            logger.info("showAudioPickerModal resolved with:", pick.mode, pick.nodes.map(n => n.displayName));
            resultNodes = pick.nodes;
        } else if (settings.store.rememberLastSelection && lastSelectedNodeNames.length > 0) {
            const keys = new Set(lastSelectedNodeNames);
            resultNodes = nodes.filter(n => keys.has(nodeKey(n)));
        }

        if (resultNodes.length === 0) {
            logger.info("No app-audio target selected; leaving audio unmodified.");
            return;
        }

        cleanupCurrentRouting = await applyAppAudioRouting(resultNodes, currentRouteFilter());
    } catch (e) {
        logger.error("Error handling app-audio picker after screenshare picker result", e);
    } finally {
        // Unblock Discord's real stream start now that our decision (with
        // or without app-audio routing applied) is final. Must run even
        // on error/no-selection, or the real stream would hang forever
        // waiting for an ack that never comes.
        ackScreenSharePicker();
    }
}

function handleDesktopSourceEnded() {
    logger.info("Real desktop-source-ended signal received; tearing down app-audio routing if active.");
    if (cleanupCurrentRouting) {
        try {
            cleanupCurrentRouting();
        } catch { /* best effort */ }
        cleanupCurrentRouting = null;
    }
    activeSelectionNodeNames = [];
}

function onScreenSharePickerResultEvent(ev: Event) {
    const detail = (ev as CustomEvent).detail ?? {};
    void handleScreenSharePickerResult(detail.kind, detail.args ?? []);
}

function onDesktopSourceEndedEvent(_ev: Event) {
    handleDesktopSourceEnded();
}

/**
 * Fires on every `ApplicationStreamingStore` change; hides the "Change
 * shared apps..." floating button and tears down routing the moment this
 * client is no longer actively streaming, regardless of *how* the share
 * ended -- clicking Discord's own "Stop Streaming" button, closing the
 * shared window, a connection drop, etc. Added as a second, independent
 * signal alongside `setOnDesktopSourceEnded`'s `desktopSourceEnded` event
 * (see `handleDesktopSourceEnded`) rather than a replacement for it:
 * confirmed live that clicking Discord's own local "Stop Streaming"
 * control did NOT reliably fire `desktopSourceEnded` (that hook appears
 * tied to the desktop *capture source* specifically ending -- e.g. the
 * shared window closing -- not every way a user can end their own local
 * share), leaving the button visible indefinitely after a manual stop.
 * `ApplicationStreamingStore` is the same general-purpose Flux store
 * other plugins already use to answer "is the current user streaming
 * right now" (see equicordplugins/whosWatching), so it should reliably
 * catch every case desktopSourceEnded doesn't.
 *
 * `getCurrentUserActiveStream()` transiently returns falsy on plain
 * guild/channel navigation while a share is genuinely still ongoing --
 * observed live, repeatedly, switching channels mid-share fires this
 * store's change event with a momentarily-empty active stream before it
 * settles back to the real one. Debounced: only actually tears down
 * routing if the falsy state is still there after a short grace period,
 * and the pending teardown is cancelled if the store reports an active
 * stream again before that fires -- a real "Stop Streaming" (or any
 * other genuine end) stays falsy well past the debounce window, so this
 * doesn't meaningfully delay a real teardown.
 */
const APPLICATION_STREAMING_STORE_DEBOUNCE_MS = 1500;
let applicationStreamingDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function onApplicationStreamingStoreChange() {
    if (ApplicationStreamingStore.getCurrentUserActiveStream()) {
        if (applicationStreamingDebounceTimer) {
            clearTimeout(applicationStreamingDebounceTimer);
            applicationStreamingDebounceTimer = null;
        }
        return;
    }
    if (applicationStreamingDebounceTimer) return;
    applicationStreamingDebounceTimer = setTimeout(() => {
        applicationStreamingDebounceTimer = null;
        if (!ApplicationStreamingStore.getCurrentUserActiveStream()) {
            handleDesktopSourceEnded();
        }
    }, APPLICATION_STREAMING_STORE_DEBOUNCE_MS);
}

function patchDiscordVoice() {
    if (pickerListenerInstalled) return;
    pickerListenerInstalled = true;
    window.addEventListener(SCREEN_SHARE_PICKER_RESULT_EVENT, onScreenSharePickerResultEvent);
    window.addEventListener(DESKTOP_SOURCE_ENDED_EVENT, onDesktopSourceEndedEvent);
    // ApplicationStreamingStore (like every @webpack/common store export)
    // is a plain mutable `export let`, populated asynchronously once
    // Discord's own webpack modules are found -- confirmed live: still
    // `undefined` at this exact point when this plugin's `startAt:
    // StartAt.Init` runs (deliberately as early as possible, see this
    // plugin's own startAt doc comment for why), which crashed this
    // entire plugin's start with "Cannot read properties of undefined
    // (reading 'addChangeListener')" and silently disabled the whole
    // plugin. `onceReady` resolves once webpack's own modules (and
    // therefore this store) are actually available.
    onceReady.then(() => {
        if (!pickerListenerInstalled) return; // unpatched again before this resolved
        ApplicationStreamingStore.addChangeListener(onApplicationStreamingStoreChange);
    });
    logger.info("Listening for native screenshare picker results and desktop-source-ended signals (patched in preload)");
}

function unpatchDiscordVoice() {
    if (!pickerListenerInstalled) return;
    pickerListenerInstalled = false;
    window.removeEventListener(SCREEN_SHARE_PICKER_RESULT_EVENT, onScreenSharePickerResultEvent);
    window.removeEventListener(DESKTOP_SOURCE_ENDED_EVENT, onDesktopSourceEndedEvent);
    // Safe even if patchDiscordVoice's own onceReady.then() hasn't
    // resolved yet (removeChangeListener on a listener that was never
    // added is a documented no-op for Flux stores) or if
    // ApplicationStreamingStore still isn't populated for some reason.
    ApplicationStreamingStore?.removeChangeListener(onApplicationStreamingStoreChange);
    if (applicationStreamingDebounceTimer) {
        clearTimeout(applicationStreamingDebounceTimer);
        applicationStreamingDebounceTimer = null;
    }
    if (cleanupCurrentRouting) {
        try {
            cleanupCurrentRouting();
        } catch { /* best effort */ }
        cleanupCurrentRouting = null;
    }
}

// Discord's own "New Audio Device Detected" prompt for patchcord's
// virtual mic is now suppressed at the source in preload
// (preload.ts's patchDeviceChangeCallback filters our virtual
// mic out of the device list before Discord's own change-detection logic
// ever sees it) -- an earlier DOM MutationObserver-based auto-dismiss
// attempt here never actually worked (confirmed live: the toast still
// appeared), so it's been removed in favor of the lower-level fix.

/**
 * Injects a "Change shared apps..." entry into Discord's own local
 * stream-controls popover -- the one with "Stop Streaming"/"Share Stream
 * Audio"/"Pop Out Stream"/"More Options", opened by clicking your own
 * active screenshare's toolbar icon. Registered for two navIds
 * (confirmed live via Discord's own devtools element inspector):
 * `manage-streams` (`aria-label="Stop Streaming"` -- the local controls
 * popover this whole feature is meant for) and `stream-context` (a
 * *different* menu, for viewing someone else's stream via
 * `biggerStreamPreview`'s identical navId, but confirmed live to also
 * render for your own stream in at least some entry points) -- same
 * handler for both, since the "is app-audio routing active" gate and the
 * action itself don't depend on which of the two menus triggered it.
 *
 * This is the only UI for reopening the picker mid-stream (an earlier
 * floating-button fallback was tried and removed after live testing
 * confirmed it had no reliable way to detect every path a user could end
 * their own stream through, leaving it stuck visible).
 */
const manageStreamsContextPatch: NavContextMenuPatchCallback = children => {
    if (!cleanupCurrentRouting) return;
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem
            id="patchcord-change-apps"
            label="Change shared audio…"
            action={() => { void reopenPickerMidStream(); }}
        />
    );
};

/**
 * Shows an explicit consent dialog for one specific native asset that
 * `nativeOrchestration` reported as `not_consented` (identified by its
 * own name + the exact checksum of the bytes actually downloaded), then
 * -- only if approved -- records that consent via `Native.recordConsent`
 * and re-runs `retry`. Declining does nothing further (the caller's
 * original action simply doesn't happen); this dialog can always be
 * triggered again later by re-attempting the same action (e.g. clicking
 * "Install audio capture shim" again).
 *
 * Note this dialog is a courtesy layer, not the security boundary --
 * `Native.recordConsent` itself independently verifies (native-side)
 * that the `(assetName, sha256)` pair being consented-to was actually
 * observed as a real pending download by this plugin's own code before
 * granting anything (see native/consentGate.ts's own doc comment). This
 * function cannot forge consent for an asset that was never genuinely
 * downloaded and hashed.
 */
async function promptConsentAndRetry<T extends { ok: boolean }>(
    result: T,
    description: string,
    retry: () => Promise<T>
): Promise<T> {
    if (result.ok) return result;
    if ((result as any).reason !== "not_consented") return result;

    const { assetName, sha256 } = result as any;

    return new Promise<T>(resolve => {
        Alerts.show({
            title: "Allow native component download?",
            body: (
                <div>
                    <p>{description}</p>
                    <p>
                        <code>{assetName}</code> (checksum <code>{sha256.slice(0, 12)}…</code>) needs to be
                        downloaded and run to continue.
                    </p>
                </div>
            ),
            confirmText: "Allow",
            cancelText: "Cancel",
            onConfirm: async () => {
                await Native.recordConsent(assetName, sha256);
                resolve(await retry());
            },
            onCancel: () => resolve(result),
        });
    });
}

/**
 * Runs the discord-capture-shim install sequence, prompting for consent
 * (per-asset, see promptConsentAndRetry) as needed, and reports the
 * final result via an alert.
 */
async function runInstallDiscordCaptureShim() {
    let result = await orchestration.installShim(Native);
    result = await promptConsentAndRetry(
        result,
        "PatchcordAppAudio needs a small native component (discord-capture-shim) to actually limit " +
        "screenshare audio to the app(s) you pick. Without it, Discord shares every detected app's audio " +
        "at once (its normal built-in behavior) regardless of what you select in this plugin's picker. " +
        "Installing patches a copy of Discord's own discord_voice.node in your current install to load " +
        "it -- a backup is kept and the patch can be undone later (Restore original discord_voice.node).",
        () => orchestration.installShim(Native)
    );

    if (result.ok) {
        logger.info("discord-capture-shim installed:", (result as any).message);
        settings.store.discordCaptureShimEverInstalled = true;
        Alerts.show({
            title: "Audio capture shim installed",
            body: <p>Per-app audio sharing is now active. You may need to restart Discord for this to take full effect.</p>,
        });
    } else if ((result as any).reason !== "not_consented") {
        logger.error("discord-capture-shim install failed:", (result as any).message);
        Alerts.show({
            title: "Audio capture shim install failed",
            body: <p>{(result as any).message}</p>,
        });
    }
    // reason === "not_consented" after promptConsentAndRetry means the
    // user declined -- no further alert needed, they just saw the
    // consent dialog itself.
}

function InstallShimButton() {
    return (
        <Button onClick={() => { void runInstallDiscordCaptureShim(); }}>
            Install audio capture shim
        </Button>
    );
}

function RestoreShimButton() {
    return (
        <Button
            color={Button.Colors.RED}
            onClick={() => {
                void (async () => {
                    let result = await orchestration.restoreShim(Native);
                    result = await promptConsentAndRetry(
                        result,
                        "Restoring requires running discord-capture-setup, the same native component used to " +
                        "install the shim.",
                        () => orchestration.restoreShim(Native)
                    );
                    if (result.ok) {
                        Alerts.show({
                            title: "Restored",
                            body: <p>discord_voice.node has been restored to its original, unpatched state.</p>,
                        });
                    } else if ((result as any).reason !== "not_consented") {
                        Alerts.show({
                            title: "Restore failed",
                            body: <p>{(result as any).message}</p>,
                        });
                    }
                })();
            }}
        >
            Restore original discord_voice.node
        </Button>
    );
}

/**
 * Shows an explicit, one-time (per decline) install-offer prompt before
 * ever attempting discord-capture-shim installation -- separate from,
 * and prior to, the per-asset download-consent prompt
 * (promptConsentAndRetry) that installShim's own not_consented results
 * trigger. This first prompt is about whether the user wants the
 * feature at all; the second is the actual native-code-execution
 * consent gate. Checks getShimStatus() first (read-only) so a user who
 * already has it installed, or whose platform doesn't support it, is
 * never asked.
 *
 * A user who previously declined this offer entirely
 * (discordCaptureShimPromptDeclined) is never shown *this* prompt again
 * -- but if they'd previously opted in and successfully installed it at
 * least once (discordCaptureShimEverInstalled), and getShimStatus() now
 * reports it's no longer installed, that means a Discord auto-update
 * silently overwrote discord_voice.node and wiped the patch. That case
 * shows a distinct "reinstall needed" prompt instead, regardless of the
 * unrelated decline flag -- someone who already chose to use this
 * feature should keep being offered to keep it working, not silently
 * lose it on the next Discord update.
 */
async function maybePromptDiscordCaptureShimInstall() {
    let status: orchestration.ShimStatus;
    try {
        status = await orchestration.getShimStatus(Native);
    } catch (e) {
        logger.error("Failed to check discord-capture-shim status", e);
        return;
    }
    if (!status.supported || status.alreadyInstalled) return;

    if (settings.store.discordCaptureShimEverInstalled) {
        Alerts.show({
            title: "Audio capture component needs reinstalling",
            body: (
                <p>
                    A Discord update replaced <code>discord_voice.node</code>, which removed the
                    discord-capture-shim patch this plugin previously installed. Reinstall it to restore
                    per-app screenshare audio -- your existing backup and consent settings are unaffected.
                </p>
            ),
            confirmText: "Reinstall",
            cancelText: "Not now",
            onConfirm: () => { void runInstallDiscordCaptureShim(); },
        });
        return;
    }

    if (settings.store.discordCaptureShimPromptDeclined) return;

    Alerts.show({
        title: "Install audio capture component?",
        body: (
            <div>
                <p>
                    PatchcordAppAudio needs a small native component (discord-capture-shim) to actually
                    limit screenshare audio to the app(s) you pick. Without it, Discord shares every
                    detected app's audio at once (its normal built-in behavior) regardless of what you
                    select in this plugin's picker.
                </p>
                <p>
                    Installing it will download two small helper binaries (you'll be asked to separately
                    confirm each download) and patch a copy of Discord's own <code>discord_voice.node</code> in
                    your current install to load it. A backup of the original file is kept, and the patch can be
                    fully undone later from this plugin's settings (Restore original discord_voice.node).
                </p>
            </div>
        ),
        confirmText: "Install",
        cancelText: "Not now",
        onConfirm: () => { void runInstallDiscordCaptureShim(); },
        onCancel: () => { settings.store.discordCaptureShimPromptDeclined = true; },
    });
}

export default definePlugin({
    name: "PatchcordAppAudio",
    description:
        "After Discord starts capturing a screenshare source, offers to route only one app's audio into the " +
        "stream (via patchcord/PipeWire) instead of your whole system's default audio output.",
    authors: [{ name: "pendo324", id: 95301288748658688n }],
    settings,

    // As early as possible: Discord's own webpack code apparently grabs a
    // reference to discord_voice's connection factory functions once,
    // very early (before WebpackReady -- confirmed live: patching at the
    // default WebpackReady stage never actually intercepted a real
    // screenshare, even though the patch itself applied successfully).
    // Init runs before Discord's webpack modules have even evaluated, so
    // our wrapped factory functions are in place before anything else can
    // capture the original references.
    startAt: StartAt.Init,

    start() {
        if (!IS_DISCORD_DESKTOP || process.platform !== "linux") {
            logger.warn("PatchcordAppAudio only applies to native Discord desktop on Linux; not patching.");
            return;
        }

        // The actual patch is applied in preload before this plugin even
        // loads (see preload.ts); this just installs the
        // window-event listener that receives its results.
        patchDiscordVoice();

        // Deferred to onceReady for the same reason ApplicationStreamingStore's
        // listener below is (see that comment) -- and, separately, because
        // showing an Alerts.show consent dialog this early in startup would
        // be poor UX even if it worked. This is the only place
        // discord-capture-shim installation is ever initiated without a
        // direct user click (the settings button), and even here it's
        // gated on an explicit confirm click in the dialog itself -- see
        // maybePromptDiscordCaptureShimInstall's own doc comment for the
        // full reasoning on why this can't just install silently.
        onceReady.then(() => { void maybePromptDiscordCaptureShimInstall(); });
    },

    stop() {
        unpatchDiscordVoice();
        orchestration.stopAppAudio().catch(() => {});
        orchestration.disposePatchcord();
    },

    contextMenus: {
        "manage-streams": manageStreamsContextPatch,
        "stream-context": manageStreamsContextPatch,
    },
});
