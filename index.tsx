/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Adds a "share this app's audio instead of system audio" picker to
 * native Discord's screenshare flow.
 *
 * Discord's native Linux desktop client does NOT use the standard Web
 * getDisplayMedia() API for screenshare when `native_screenshare_picker`
 * is active (confirmed live: it never fires; confirmed via strings on
 * discord_voice.node that `features.declareSupported('native_screenshare_
 * picker')` is set whenever XDG_SESSION_TYPE starts with "wayland"). The
 * whole flow instead runs through the `discord_voice` native module
 * (discord_voice.node, loaded like discord_utils via
 * DiscordNative.nativeModules.requireModule("discord_voice")), which
 * calls straight into `BaseCapturerPipeWire` in C++, bypassing Chromium's
 * desktopCapturer/getDisplayMedia entirely for both the video source AND
 * (per the `SetWumpusSource`/`SetScreenshareSourceLinux` native symbols)
 * potentially audio-source selection.
 *
 * The real hook point is `VoiceEngine.createVoiceConnectionWithOptions`
 * (the module's exported connection factory): every real voice/stream
 * connection Discord ever makes goes through it, and the object it
 * returns exposes `setDesktopSourceWithOptions(options)` -- the same
 * function `discord_voice.node`'s native `SetDesktopSourceWithOptions`
 * binding backs. We wrap that factory so every connection's
 * `setDesktopSourceWithOptions` is intercepted: our own overlay modal
 * (independent of Discord's own DOM/CSS, which was the actual root cause
 * of two earlier, now-abandoned modal-injection attempts -- Discord's
 * button text and CSS module hashes both turned out to be a moving
 * target) is shown right when Discord tries to actually start the
 * desktop-source capture, i.e. right after the user has finished the
 * real (portal-native) window/screen picker.
 */

import { definePluginSettings } from "@api/Settings";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { Alerts, ApplicationStreamingStore, Button, Menu } from "@webpack/common";
import { onceReady } from "@webpack";

const logger = new Logger("PatchcordAppAudio");

const Native = VencordNative.pluginHelpers.PatchcordAppAudio as PluginNative<typeof import("./native")>;

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

async function fetchShareableNodes(includeDevices = false): Promise<ShareableNode[]> {
    try {
        return await Native.listShareableNodes(includeDevices);
    } catch (e) {
        logger.error("Failed to list shareable nodes", e);
        return [];
    }
}

async function fetchScreencastHint(): Promise<ScreencastHint | null> {
    try {
        return await Native.findScreencastHint();
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
 * Our own small overlay modal, fully independent of Discord's DOM/CSS.
 * Resolves with the chosen ShareableNode, or null for "use normal system
 * audio".
 */
/**
 * Discord's real design-token custom properties (--background-primary,
 * --interactive-normal, --brand-experiment, etc.) are set on <html>/<body>
 * by Discord's own theme CSS and are available anywhere in the page, so
 * our overlay can just reference them directly via var() to automatically
 * match the user's actual theme (including custom themes/QuickCSS)
 * instead of hardcoding one dark-mode palette. Fallback values (after the
 * comma) keep the modal usable even if a variable is ever missing.
 */
const DISCORD_VARS = {
    bgPrimary: "var(--background-primary, #313338)",
    bgSecondary: "var(--background-secondary, #2b2d31)",
    bgSecondaryAlt: "var(--background-secondary-alt, #2b2d31)",
    bgFloating: "var(--background-floating, #222327)",
    bgModifierHover: "var(--background-modifier-hover, rgba(78,80,88,0.3))",
    bgModifierSelected: "var(--background-modifier-selected, rgba(78,80,88,0.5))",
    textNormal: "var(--text-normal, #f2f3f5)",
    textMuted: "var(--text-muted, #949ba4)",
    textLink: "var(--text-link, #00a8fc)",
    interactiveNormal: "var(--interactive-normal, #b5bac1)",
    brand: "var(--brand-experiment, #5865f2)",
    brandHover: "var(--brand-experiment-560, #4752c4)",
    buttonSecondaryBg: "var(--button-secondary-background, #4e5058)",
    borderSubtle: "var(--border-subtle, rgba(255,255,255,0.06))",
    fontPrimary: "var(--font-primary, 'gg sans', 'Noto Sans', sans-serif)",
    fontDisplay: "var(--font-display, 'gg sans', 'Noto Sans', sans-serif)",
    elevationHigh: "var(--elevation-high, 0 8px 16px rgba(0,0,0,0.24))",
};

/**
 * Multi-select checklist. Electron's native <select> popup renders via a
 * separate OS-level surface that doesn't compose correctly inside
 * Discord's frameless/custom-titlebar window -- confirmed live: the
 * closed <select> displayed fine, but the opened options list was
 * completely non-interactable (clicks passed through to whatever was
 * beneath it). A plain absolutely-positioned <div> list, entirely within
 * normal DOM/CSS z-stacking, has no such issue.
 *
 * Used for both "pick one or more apps to share" (item 4's Granular
 * Selection) and "pick apps to exclude from Entire System" (item 5) --
 * the only difference between those two usages is which list of nodes
 * gets passed in and how the caller interprets the resulting id set, not
 * the widget itself.
 */
function createMultiSelect(
    options: { value: string; label: string; disabled?: boolean; node: ShareableNode | null; }[],
    initialValues: Set<string>,
    initialPlaceholder: string
) {
    let placeholder = initialPlaceholder;
    const root = document.createElement("div");
    root.style.cssText = "position: relative; width: 100%;";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.style.cssText = `
        width: 100%; box-sizing: border-box; text-align: left;
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border-radius: 4px; border: none; cursor: pointer;
        background: ${DISCORD_VARS.bgSecondaryAlt}; color: ${DISCORD_VARS.textNormal};
        font-family: ${DISCORD_VARS.fontPrimary}; font-size: 14px; font-weight: 500;
    `;

    const triggerLabel = document.createElement("span");
    triggerLabel.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    trigger.appendChild(triggerLabel);

    const chevron = document.createElement("span");
    chevron.textContent = "\u25be";
    chevron.style.cssText = `color: ${DISCORD_VARS.interactiveNormal}; margin-left: 8px; flex-shrink: 0;`;
    trigger.appendChild(chevron);

    const list = document.createElement("div");
    list.style.cssText = `
        position: absolute; top: calc(100% + 4px); left: 0; right: 0;
        max-height: 240px; overflow-y: auto; z-index: 10;
        background: ${DISCORD_VARS.bgFloating}; border-radius: 8px;
        box-shadow: ${DISCORD_VARS.elevationHigh};
        padding: 6px; display: none;
    `;

    let currentValues = new Set(initialValues);
    const optionEls = new Map<string, { row: HTMLDivElement; check: HTMLSpanElement; }>();

    function setOpen(open: boolean) {
        list.style.display = open ? "block" : "none";
        chevron.textContent = open ? "\u25b4" : "\u25be";
    }

    function updateTriggerLabel() {
        if (currentValues.size === 0) {
            triggerLabel.textContent = placeholder;
            return;
        }
        const labels = options.filter(o => currentValues.has(o.value)).map(o => o.label);
        triggerLabel.textContent = labels.length === 1 ? labels[0] : `${labels.length} selected`;
    }

    function updateRowVisual(value: string) {
        const entry = optionEls.get(value);
        if (!entry) return;
        const isSelected = currentValues.has(value);
        entry.row.style.background = isSelected ? DISCORD_VARS.bgModifierSelected : "transparent";
        entry.check.style.opacity = isSelected ? "1" : "0";
    }

    function toggleValue(value: string) {
        if (currentValues.has(value)) {
            currentValues.delete(value);
        } else {
            currentValues.add(value);
        }
        updateRowVisual(value);
        updateTriggerLabel();
    }

    function render() {
        list.innerHTML = "";
        optionEls.clear();
        for (const opt of options) {
            const el = document.createElement("div");
            el.style.cssText = `
                display: flex; align-items: center; gap: 8px;
                padding: 8px 10px; border-radius: 4px; cursor: ${opt.disabled ? "default" : "pointer"};
                font-size: 14px; color: ${opt.disabled ? DISCORD_VARS.textMuted : DISCORD_VARS.textNormal};
                font-style: ${opt.disabled ? "italic" : "normal"};
            `;

            const check = document.createElement("span");
            check.textContent = "\u2713";
            check.style.cssText = `width: 14px; flex-shrink: 0; color: ${DISCORD_VARS.brand}; opacity: 0;`;
            el.appendChild(check);

            const labelEl = document.createElement("span");
            labelEl.textContent = opt.label;
            labelEl.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            el.appendChild(labelEl);

            if (!opt.disabled) {
                el.onmouseenter = () => { if (!currentValues.has(opt.value)) el.style.background = DISCORD_VARS.bgModifierHover; };
                el.onmouseleave = () => { if (!currentValues.has(opt.value)) el.style.background = "transparent"; };
                el.onclick = () => toggleValue(opt.value);
            }
            list.appendChild(el);
            optionEls.set(opt.value, { row: el, check });
        }
        for (const value of currentValues) updateRowVisual(value);
        updateTriggerLabel();
    }

    render();

    trigger.onclick = () => setOpen(list.style.display === "none");

    root.appendChild(trigger);
    root.appendChild(list);

    return {
        root,
        getValues: () => new Set(currentValues),
        getSelectedNodes: () => options.filter(o => currentValues.has(o.value) && o.node).map(o => o.node!),
        setOptions: (newOptions: typeof options, values: Set<string>, newPlaceholder?: string) => {
            options = newOptions;
            currentValues = new Set(values);
            if (newPlaceholder !== undefined) placeholder = newPlaceholder;
            render();
        },
        close: () => setOpen(false),
        focus: () => trigger.focus(),
    };
}


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
 * Previously fell back to plain `node.nodeName` when present (e.g.
 * "Firefox"), which is NOT unique -- confirmed live: every tab/window an
 * app opens shares the exact same `node.name`, so two live Firefox tabs
 * collided on the identical key, silently merging them into a single
 * selectable/toggleable entry in the multi-select (toggling one toggled
 * both, and only one was ever actually distinguishable in
 * `currentValues`). `node.id` is `ShareableNode.id`, the live PipeWire
 * registry id -- guaranteed unique among currently-live nodes, which is
 * exactly the uniqueness this key needs. It does change across process
 * restarts (a relaunched Firefox gets a fresh id), which is why
 * `nodeName` was preferred before for the "remember my last selection
 * between shares" feature to survive that -- but that goal was already
 * unachievable in exactly the multi-tab-collision case this fixes (there
 * would be no way to tell *which* remembered tab to reselect even if the
 * key did survive), so always keying by the specific live id is strictly
 * more correct: single-instance apps (Spotify, Discord's own capture,
 * etc.) still round-trip through `lastSelectedNodeNames` correctly in
 * the common case where the same node.name only ever resolves to one
 * live id at a time, and never silently merges distinct nodes together.
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

function showAudioPickerModal(
    initialNodes: ShareableNode[],
    initialHint: ScreencastHint | null,
    initialMode: PickerMode = "none"
): Promise<PickerResult> {
    logger.info("showAudioPickerModal called with", initialNodes.length, "nodes, hint =", initialHint);
    return new Promise(resolve => {
        let nodes = initialNodes;
        let hint = initialHint;
        let mode: PickerMode = "none";
        let isFirstRender = true;
        let filterActive = hint != null;
        let refreshing = false;

        const shareableFor = (list: ShareableNode[]) =>
            list.filter(n => !n.isVirtual && (settings.store.deviceSelect && !settings.store.ignoreDevices ? true : !n.isDevice));

        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 999999;
            background: rgba(0,0,0,0.85);
            display: flex; align-items: center; justify-content: center;
            font-family: ${DISCORD_VARS.fontPrimary};
        `;

        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: ${DISCORD_VARS.bgPrimary}; color: ${DISCORD_VARS.textNormal};
            border-radius: 8px; padding: 24px; width: 480px; max-width: 90vw;
            box-shadow: ${DISCORD_VARS.elevationHigh};
        `;

        const headerRow = document.createElement("div");
        headerRow.style.cssText = "display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px;";

        const title = document.createElement("div");
        title.textContent = "Share app audio? (patchcord)";
        title.style.cssText = `font-family: ${DISCORD_VARS.fontDisplay}; font-size: 20px; font-weight: 700; color: ${DISCORD_VARS.textNormal};`;
        headerRow.appendChild(title);

        const refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.textContent = "\u21bb Refresh";
        refreshBtn.title = "Re-scan audio sources (e.g. after starting playback in an app)";
        refreshBtn.style.cssText = `
            padding: 5px 10px; border-radius: 4px; border: none; cursor: pointer;
            font-weight: 500; font-size: 12px; font-family: ${DISCORD_VARS.fontPrimary};
            background: ${DISCORD_VARS.buttonSecondaryBg}; color: ${DISCORD_VARS.textNormal};
            flex-shrink: 0; white-space: nowrap;
        `;
        headerRow.appendChild(refreshBtn);
        dialog.appendChild(headerRow);

        const description = document.createElement("div");
        description.style.cssText = `font-size: 14px; line-height: 1.4; color: ${DISCORD_VARS.textMuted}; margin-bottom: 12px;`;
        dialog.appendChild(description);

        // --- mode switcher (item 5: None / Apps / Entire System) -------
        const modeRow = document.createElement("div");
        modeRow.style.cssText = "display: flex; gap: 6px; margin-bottom: 12px;";
        const modeButtons = new Map<PickerMode, HTMLButtonElement>();
        const MODES: { value: PickerMode; label: string; }[] = [
            { value: "none", label: "None" },
            { value: "apps", label: "Specific Apps" },
            { value: "system", label: "Entire System" },
        ];
        for (const m of MODES) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = m.label;
            btn.style.cssText = `
                flex: 1; padding: 8px 10px; border-radius: 4px; border: none; cursor: pointer;
                font-weight: 500; font-size: 13px; font-family: ${DISCORD_VARS.fontPrimary};
                transition: background 0.15s ease;
            `;
            btn.onclick = () => setMode(m.value);
            modeRow.appendChild(btn);
            modeButtons.set(m.value, btn);
        }
        dialog.appendChild(modeRow);

        function updateModeButtonStyles() {
            for (const [value, btn] of modeButtons) {
                const active = value === mode;
                btn.style.background = active ? DISCORD_VARS.brand : DISCORD_VARS.buttonSecondaryBg;
                btn.style.color = "#fff";
            }
        }

        let hintNotice: HTMLDivElement | null = null;
        if (hint) {
            hintNotice = document.createElement("div");
            hintNotice.style.cssText = `font-size: 12px; color: ${DISCORD_VARS.textMuted}; margin-bottom: 8px;`;
        }

        function toOptions(list: ShareableNode[]) {
            const opts: { value: string; label: string; disabled?: boolean; node: ShareableNode | null; }[] = [];
            for (const node of list) {
                opts.push({ value: nodeKey(node), label: nodeLabel(node), node });
            }
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

        const selectContainer = document.createElement("div");
        let multi: ReturnType<typeof createMultiSelect> | null = null;

        function currentAppList(): ShareableNode[] {
            const shareable = shareableFor(nodes);
            const matched = hint ? shareable.filter(n => nodeMatchesHint(n, hint!)) : [];
            return filterActive && matched.length > 0 ? matched : shareable;
        }

        function preselectedValues(list: ShareableNode[]): Set<string> {
            // The very first render, when reopened mid-stream with an
            // active selection (initialMode === "apps"): preselect
            // exactly what's actually routed right now, regardless of
            // the separate "remember last selection" setting -- see
            // activeSelectionNodeNames's own doc comment for why that
            // setting shouldn't gate this. Only applies once; any
            // subsequent render in this same modal (mode switches,
            // Refresh) falls through to the normal
            // lastSelectedNodeNames-based behavior below, unchanged from
            // before.
            if (isFirstRender && initialMode === "apps" && activeSelectionNodeNames.length > 0) {
                const keys = new Set(list.map(nodeKey));
                return new Set(activeSelectionNodeNames.filter(n => keys.has(n)));
            }
            if (!settings.store.rememberLastSelection || lastSelectedNodeNames.length === 0) return new Set();
            const keys = new Set(list.map(nodeKey));
            return new Set(lastSelectedNodeNames.filter(n => keys.has(n)));
        }

        function updateHintNotice() {
            if (!hintNotice || !hint || mode !== "apps") return;
            hintNotice.textContent = "";
            const shareable = shareableFor(nodes);
            const matched = shareable.filter(n => nodeMatchesHint(n, hint!));
            if (filterActive && matched.length > 0) {
                hintNotice.append(`Filtered to apps matching your shared window ("${hint.hint}"). `);
                const link = document.createElement("a");
                link.href = "#";
                link.textContent = "Show all apps instead";
                link.style.color = DISCORD_VARS.textLink;
                link.onclick = e => {
                    e.preventDefault();
                    filterActive = false;
                    renderList();
                };
                hintNotice.appendChild(link);
            } else if (matched.length > 0) {
                hintNotice.append(`Not filtering by shared window ("${hint.hint}" match available). `);
                const link = document.createElement("a");
                link.href = "#";
                link.textContent = "Filter to likely match";
                link.style.color = DISCORD_VARS.textLink;
                link.onclick = e => {
                    e.preventDefault();
                    filterActive = true;
                    renderList();
                };
                hintNotice.appendChild(link);
            } else {
                hintNotice.append(`Couldn't match any audio app to your shared window ("${hint.hint}").`);
            }
        }

        function renderList() {
            selectContainer.innerHTML = "";

            if (mode === "none") {
                description.textContent = "Discord will share its normal (whole-system default) audio, same as without this plugin.";
                if (hintNotice) hintNotice.remove();
                groupByAppRow.style.display = "none";
                shareBtn.textContent = "Start Sharing";
                return;
            }

            if (mode === "apps") {
                description.textContent =
                    "Route only the selected apps' audio into this screenshare instead of your whole system's " +
                    "default output. Pick one or more.";
                const list = currentAppList();
                const preselected = preselectedValues(list);
                isFirstRender = false;
                if (multi) {
                    multi.setOptions(toOptions(list), preselected, "Select apps to share\u2026");
                } else {
                    multi = createMultiSelect(toOptions(list), preselected, "Select apps to share\u2026");
                }
                selectContainer.appendChild(multi.root);
                if (hintNotice) {
                    selectContainer.insertBefore(hintNotice, multi.root);
                    updateHintNotice();
                }
                groupByAppRow.style.display = "flex";
                shareBtn.textContent = "Start Sharing";
                return;
            }

            // mode === "system"
            description.textContent =
                "Route your whole system's default audio into this screenshare, except the apps excluded below " +
                "(matches Discord's usual \"Stream With Audio\" behavior, but lets you leave specific apps out).";
            if (hintNotice) hintNotice.remove();
            const excludable = shareableFor(nodes);
            const preselected = preselectedValues(excludable);
            if (multi) {
                multi.setOptions(toOptions(excludable), preselected, "Exclude apps (optional)\u2026");
            } else {
                multi = createMultiSelect(toOptions(excludable), preselected, "Exclude apps (optional)\u2026");
            }
            selectContainer.appendChild(multi.root);
            // "Group by application" only makes sense when picking specific
            // apps to include -- "Entire System" mode already includes
            // every node from every app minus the excluded ones, whether
            // grouping is on or not (see applyAppAudioRouting's own
            // comment on the same point).
            groupByAppRow.style.display = "none";
            shareBtn.textContent = "Start Sharing";
        }

        function setMode(next: PickerMode) {
            mode = next;
            updateModeButtonStyles();
            renderList();
        }

        dialog.appendChild(selectContainer);

        // --- "group by application" (promoted out of Advanced audio
        // filters -- more immediately useful than the rest of that
        // panel, and only meaningful in "apps" mode, so it's toggled
        // visible/hidden by renderList() itself rather than hidden
        // behind an extra click every time). --------------------------
        const groupByAppRow = document.createElement("label");
        groupByAppRow.style.cssText = "display: none; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin-top: 10px;";
        const groupByAppCheckbox = document.createElement("input");
        groupByAppCheckbox.type = "checkbox";
        groupByAppCheckbox.checked = !!settings.store.groupByApplication;
        groupByAppCheckbox.onchange = () => {
            settings.store.groupByApplication = groupByAppCheckbox.checked;
        };
        groupByAppRow.appendChild(groupByAppCheckbox);
        const groupByAppLabel = document.createElement("span");
        groupByAppLabel.textContent = "Share all tabs/windows of each picked app (not just the one selected)";
        groupByAppLabel.style.color = DISCORD_VARS.textNormal;
        groupByAppRow.appendChild(groupByAppLabel);
        dialog.appendChild(groupByAppRow);

        // --- advanced filters (item 4: granular/device selection + the
        // rest of patchcord's RouteFilter) -------------------------------
        const advancedToggle = document.createElement("a");
        advancedToggle.href = "#";
        advancedToggle.textContent = "Advanced audio filters \u25be";
        advancedToggle.style.cssText = `display: inline-block; font-size: 12px; color: ${DISCORD_VARS.textLink}; margin-top: 12px;`;
        dialog.appendChild(advancedToggle);

        const advancedPanel = document.createElement("div");
        advancedPanel.style.cssText = "display: none; margin-top: 8px; display: grid; gap: 8px;";
        advancedPanel.style.display = "none";
        dialog.appendChild(advancedPanel);

        const ADVANCED_TOGGLES: { key: "onlySpeakers" | "onlyDefaultSpeakers" | "ignoreInputMedia" | "ignoreVirtual" | "ignoreDevices" | "deviceSelect"; label: string; }[] = [
            { key: "onlySpeakers", label: "Only Speakers" },
            { key: "onlyDefaultSpeakers", label: "Only Default Speakers" },
            { key: "ignoreInputMedia", label: "Ignore Inputs" },
            { key: "ignoreVirtual", label: "Ignore Virtual" },
            { key: "ignoreDevices", label: "Ignore Devices" },
            { key: "deviceSelect", label: "Device Selection" },
        ];
        for (const t of ADVANCED_TOGGLES) {
            const row = document.createElement("label");
            row.style.cssText = "display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = !!settings.store[t.key];
            checkbox.onchange = () => {
                (settings.store as any)[t.key] = checkbox.checked;
                renderList();
            };
            row.appendChild(checkbox);
            const label = document.createElement("span");
            label.textContent = t.label;
            label.style.color = DISCORD_VARS.textNormal;
            row.appendChild(label);
            advancedPanel.appendChild(row);
        }

        let advancedOpen = false;
        advancedToggle.onclick = e => {
            e.preventDefault();
            advancedOpen = !advancedOpen;
            advancedPanel.style.display = advancedOpen ? "grid" : "none";
            advancedToggle.textContent = advancedOpen ? "Advanced audio filters \u25b4" : "Advanced audio filters \u25be";
        };

        const buttonRow = document.createElement("div");
        buttonRow.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;";

        function makeButton(text: string, primary: boolean): HTMLButtonElement {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = text;
            btn.style.cssText = `
                padding: 9px 16px; border-radius: 4px; border: none; cursor: pointer;
                font-weight: 500; font-size: 14px; font-family: ${DISCORD_VARS.fontPrimary};
                background: ${primary ? DISCORD_VARS.brand : DISCORD_VARS.buttonSecondaryBg};
                color: #fff; transition: background 0.15s ease;
            `;
            btn.onmouseenter = () => { btn.style.background = primary ? DISCORD_VARS.brandHover : DISCORD_VARS.bgModifierHover; };
            btn.onmouseleave = () => { btn.style.background = primary ? DISCORD_VARS.brand : DISCORD_VARS.buttonSecondaryBg; };
            return btn;
        }

        function computeResultNodes(): ShareableNode[] {
            if (mode === "none") return [];
            if (mode === "apps") return multi?.getSelectedNodes() ?? [];
            // system: every currently-known shareable node minus the
            // excluded selection. Filtering (onlySpeakers etc.) is applied
            // server-side by patchcord's routeNodes itself, so this is
            // deliberately the *unfiltered* candidate set, not
            // pre-trimmed here -- see currentRouteFilter().
            const excludedKeys = new Set((multi?.getSelectedNodes() ?? []).map(nodeKey));
            return shareableFor(nodes).filter(n => !excludedKeys.has(nodeKey(n)));
        }

        function finish(cancelled = false) {
            const resultNodes = computeResultNodes();
            if (!cancelled) {
                // Cancel (Escape) must never touch either of these --
                // mode was already forced to "none" by the Escape
                // handler purely to make computeResultNodes() return an
                // empty result for the (unused, since cancelled=true)
                // `nodes` field, not because anything should actually
                // change.
                activeSelectionNodeNames = mode === "apps" ? resultNodes.map(nodeKey) : [];
                if (settings.store.rememberLastSelection) {
                    lastSelectedNodeNames = activeSelectionNodeNames;
                }
            }
            overlay.remove();
            document.removeEventListener("keydown", onKeydown, true);
            resolve({ mode, nodes: resultNodes, cancelled });
        }

        const shareBtn = makeButton("Start Sharing", true);
        shareBtn.onclick = () => finish(false);

        const skipBtn = makeButton("Skip (normal audio)", false);
        skipBtn.onclick = () => {
            mode = "none";
            finish();
        };

        refreshBtn.onclick = async () => {
            if (refreshing) return;
            refreshing = true;
            const prevText = refreshBtn.textContent;
            refreshBtn.textContent = "Refreshing\u2026";
            refreshBtn.disabled = true;
            try {
                const includeDevices = settings.store.deviceSelect && !settings.store.ignoreDevices;
                const [newNodes, newHint] = await Promise.all([
                    fetchShareableNodes(includeDevices),
                    fetchScreencastHint(),
                ]);
                nodes = newNodes;
                hint = newHint;
                if (hint == null) filterActive = false;
                renderList();
            } finally {
                refreshing = false;
                refreshBtn.textContent = prevText;
                refreshBtn.disabled = false;
            }
        };

        buttonRow.appendChild(skipBtn);
        buttonRow.appendChild(shareBtn);
        dialog.appendChild(buttonRow);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        logger.info("Audio picker overlay appended to document.body. body.contains(overlay):", document.body.contains(overlay), "overlay rect:", overlay.getBoundingClientRect());

        function onKeydown(e: KeyboardEvent) {
            if (e.key === "Escape") { multi?.close(); mode = "none"; finish(true); }
        }
        document.addEventListener("keydown", onKeydown, true);

        setMode(initialMode);
    });
}

/**
 * Actually applies app-audio routing once the user has picked one or more
 * nodes from our overlay modal: links those nodes' audio directly into
 * every live `discord_capture` node -- Discord's own native per-app
 * screenshare-audio capture, confirmed this session (via a real
 * disconnect/reconnect test against a live viewer) to be the actual
 * audio path "Stream With Audio" uses. This requires
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

        const ok = await Native.startAppAudio(nodes.map(n => n.id), filter, groupApplicationNames);
        if (!ok) {
            logger.warn("patchcord failed to start app audio routing.");
            return null;
        }

        logger.info(`App audio routing active for ${nodes.length} node(s) via discord_capture direct link.`);
        return () => {
            Native.stopAppAudio?.().catch(() => {});
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
 * The actual patch now lives in Equicord core's preload.ts /
 * discordNativePatch.ts, applied to the real, single, pre-bridge
 * DiscordNative object before contextBridge.exposeInMainWorld ever clones
 * it out. That preload-side patch dispatches a plain `window` CustomEvent
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
 * discordNativePatch.ts's waitForPickerAck) so Discord's real stream-start
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
 */
function onApplicationStreamingStoreChange() {
    if (!ApplicationStreamingStore.getCurrentUserActiveStream()) {
        handleDesktopSourceEnded();
    }
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
    if (cleanupCurrentRouting) {
        try {
            cleanupCurrentRouting();
        } catch { /* best effort */ }
        cleanupCurrentRouting = null;
    }
}

// Discord's own "New Audio Device Detected" prompt for patchcord's
// virtual mic is now suppressed at the source in preload
// (discordNativePatch.ts's patchDeviceChangeCallback filters our virtual
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
 * Runs `installDiscordCaptureShim` (the actual download+patch, see its
 * own doc comment in native.ts for why this has to be a distinct,
 * explicitly user-triggered action rather than something that runs
 * automatically) and reports the result via a toast/log, so the button
 * gives real feedback either way instead of silently succeeding or
 * failing.
 */
async function runInstallDiscordCaptureShim() {
    const result = await Native.installDiscordCaptureShim();
    if (result.ok) {
        logger.info("discord-capture-shim installed:", result.message);
        Alerts.show({
            title: "Audio capture shim installed",
            body: <p>Per-app audio sharing is now active. You may need to restart Discord for this to take full effect.</p>,
        });
    } else {
        logger.error("discord-capture-shim install failed:", result.message);
        Alerts.show({
            title: "Audio capture shim install failed",
            body: <p>{result.message}</p>,
        });
    }
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
                void Native.restoreDiscordCaptureShim().then(() => {
                    Alerts.show({
                        title: "Restored",
                        body: <p>discord_voice.node has been restored to its original, unpatched state.</p>,
                    });
                });
            }}
        >
            Restore original discord_voice.node
        </Button>
    );
}

/**
 * Shows an explicit, one-time (per decline) consent prompt before ever
 * downloading or running discord-capture-shim/discord-capture-setup --
 * see installDiscordCaptureShim's own doc comment in native.ts for why
 * this can't just run silently on plugin start. Checks
 * getDiscordCaptureShimStatus() first (a read-only, no-side-effects
 * check) so a user who already installed it, or whose platform doesn't
 * support it at all, is never asked. Declining sets
 * discordCaptureShimPromptDeclined so the prompt doesn't reappear every
 * launch -- the "Install audio capture shim" settings button remains
 * available any time the user changes their mind.
 */
async function maybePromptDiscordCaptureShimInstall() {
    if (settings.store.discordCaptureShimPromptDeclined) return;

    let status: Awaited<ReturnType<typeof Native.getDiscordCaptureShimStatus>>;
    try {
        status = await Native.getDiscordCaptureShimStatus();
    } catch (e) {
        logger.error("Failed to check discord-capture-shim status", e);
        return;
    }
    if (!status.supported || status.alreadyInstalled) return;

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
                    Installing it will download two small helper binaries and patch a copy of Discord's
                    own <code>discord_voice.node</code> in your current install to load it. A backup of
                    the original file is kept, and the patch can be fully undone later from this plugin's
                    settings (Restore original discord_voice.node).
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
        // loads (see discordNativePatch.ts); this just installs the
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
        Native.stopAppAudio?.();
    },

    contextMenus: {
        "manage-streams": manageStreamsContextPatch,
        "stream-context": manageStreamsContextPatch,
    },
});
