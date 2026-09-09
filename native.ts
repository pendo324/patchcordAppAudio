/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Main-process bridge to `patchcord`, the native PipeWire helper already
 * built and verified in this session (see ~/Code/patchcord). Spawns it,
 * exposes listShareableNodes/setDiscordCaptureTargets/dispose to the
 * renderer via pluginHelpers.
 *
 * ARCHITECTURE (rewritten this session after live-verifying the previous
 * mic-swap approach was targeting the wrong mechanism entirely):
 *
 * Discord's native Linux "Stream With Audio" feature does not go through
 * microphone-input-device selection at all. Confirmed live: Discord
 * creates one PipeWire `Stream/Input/Audio` node per audio-producing app
 * it detects (`node.name="discord_capture"`, `media.name="game
 * capture"`, `application.process.binary="Discord"`), reads audio from
 * it directly in-process (`pw_stream_dequeue_buffer`), and links each
 * one individually to its target app's output via an explicit
 * `target.object` property plus `node.autoconnect=true` -- confirmed by
 * disconnecting one app's link to its `discord_capture` node and
 * observing that app go silent for a live viewer instantly, then
 * restoring it by reconnecting. Since every detected app gets its own
 * simultaneously-live `discord_capture` link, by default a viewer hears
 * *everything* at once, with no existing way to pick just one.
 *
 * The virtual-sink/virtual-mic + `enumerateDevices()` device-swap
 * approach previously used here targeted Discord's *microphone input*
 * selection, which `discord_capture` has nothing to do with -- that
 * code ran, "succeeded", and had zero actual effect on what viewers
 * heard. (It also, separately, never even applied the mic deviceId it
 * resolved to anything -- a second, independent bug in that dead code
 * path.)
 *
 * The actual fix has two parts:
 *   1. `discord-capture-shim` (a separate `LD_PRELOAD` native library,
 *      NOT part of this plugin -- see ~/Code/patchcord/crates/
 *      discord-capture-shim and its own doc comment) strips
 *      `target.object`/`node.autoconnect` from Discord's own
 *      `discord_capture` streams before they're created, so they come
 *      up unlinked instead of auto-targeted.
 *   2. This plugin calls patchcord's `setDiscordCaptureTargets(nodeIds)`
 *      (implemented in patchcord's `state_native.rs`, exposed via
 *      `main.rs`'s JSON-RPC protocol) to link the user's actually-selected
 *      app(s) directly into every live `discord_capture` node, reacting
 *      to graph changes server-side (patchcord's own `graphChanged`
 *      handling) so a freshly-created `discord_capture` instance -- a
 *      newly launched app, or the target app restarting -- gets linked
 *      without this plugin needing to notice and re-request anything.
 *
 * No virtual sink or virtual mic is created or used by this path at all
 * -- `discord_capture` is Discord's own node, so there's nothing to swap
 * a mic device into. `ensureVirtualSink`/`routeNodes`/mic-mute plumbing
 * from the old approach has been removed entirely rather than left as
 * unused dead code.
 *
 * Without `discord-capture-shim` actually installed and LD_PRELOAD'd
 * into the real Discord binary (see that crate's own install
 * instructions), `setDiscordCaptureTargets` calls below still run and
 * still create links, but Discord's own auto-linking will keep adding
 * *every other* detected app's link right alongside them -- this plugin
 * cannot itself detect or warn about the shim being missing, since
 * there is no PipeWire-visible signal that distinguishes "shim active,
 * autoconnect suppressed" from "shim absent, autoconnect happening
 * anyway" from patchcord's side.
 */

import { app } from "electron";
import { dirname, join } from "path";
import { existsSync, statSync } from "fs";
import { mkdir, writeFile, chmod, readdir, copyFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Reuses the same patchcord node.js client shape already built and
// tested against a real running patchcord binary earlier in this
// session. Equicord (unlike GoofCord) doesn't have `patchcord` as an npm
// dependency, so this imports the local built package directly; ship a
// copy of ~/Code/patchcord/node/{patchcord.js,patchcord.d.ts} alongside
// this plugin (see README.md in this folder) rather than fetching from
// npm, since patchcord isn't published there.
import { AudioSharePatchbay, type ShareableNode, type ScreencastHint, type RouteFilter } from "./patchcordClient";

let patchbay: AudioSharePatchbay | undefined;
let hasPipewirePulse = false;

function binaryDir(): string {
    return join(app.getPath("userData"), "..", "Equicord", "patchcordAppAudio");
}

function binaryName(): string {
    if (process.platform !== "linux") {
        throw new Error(`patchcordAppAudio only supports Linux (got ${process.platform})`);
    }
    if (process.arch !== "x64" && process.arch !== "arm64") {
        throw new Error(`patchcordAppAudio only supports x64/arm64 (got ${process.arch})`);
    }
    return `patchcord-linux-${process.arch}`;
}

/**
 * No prebuilt patchcord release exists upstream yet (same situation as
 * goofbind -- see the sibling goofbindKeybinds plugin's native.ts for the
 * identical caveat). Until one exists, build patchcord yourself:
 *   git clone https://github.com/Milkshiift/patchcord && cargo build --release
 * and place the resulting `target/release/patchcord` binary at the path
 * this function computes.
 *
 * `PATCHCORD_APP_AUDIO_RELEASE_URL_BASE`, if set, overrides where all
 * three downloadable assets (patchcord itself, discord-capture-shim.so,
 * discord-capture-setup) are fetched from -- e.g.
 * `PATCHCORD_APP_AUDIO_RELEASE_URL_BASE=http://127.0.0.1:8787` while
 * running `python3 -m http.server 8787` from a local
 * `target/release`-style directory containing exactly these three
 * files, named per `binaryName()`/`shimAssetNames()` below. This exists
 * purely so the whole download-and-install flow (asset naming, fetch,
 * write, chmod, then discord-capture-setup actually invoked against a
 * real discord_voice.node) can be exercised end-to-end without a real
 * GitHub release existing yet -- see this session's chat history for why
 * that gap mattered (the previous "verification" only tested each piece
 * in isolation, never the actual fetch() path).
 */
const DEFAULT_RELEASE_URL_BASE = "https://github.com/Milkshiift/patchcord/releases/latest/download";
const PATCHCORD_RELEASE_URL_BASE = process.env.PATCHCORD_APP_AUDIO_RELEASE_URL_BASE || DEFAULT_RELEASE_URL_BASE;

/**
 * Downloads a single release asset into `binaryDir()` (creating it if
 * needed) and marks it executable. Shared by `ensureBinary` (patchcord
 * itself) and `ensureShimAssets` (discord-capture-shim.so +
 * discord-capture-setup, see that function's doc comment) -- all three
 * are plain files published on the same GitHub release, just with
 * different names, so there's no reason to duplicate the fetch/write
 * logic three times.
 */
async function downloadAsset(assetName: string, releaseUrlBase: string): Promise<string> {
    const dir = binaryDir();
    const file = join(dir, assetName);
    if (existsSync(file)) return file;

    await mkdir(dir, { recursive: true });
    const url = `${releaseUrlBase}/${assetName}`;
    console.log("[patchcordAppAudio] Downloading", assetName, "from", url);

    let res: Response;
    try {
        res = await fetch(url);
    } catch (e) {
        throw new Error(
            `[patchcordAppAudio] Failed to download ${assetName} (network error): ${(e as Error).message}. ` +
            `No prebuilt release exists upstream yet -- build it yourself and place it at ${file}`
        );
    }
    if (!res.ok) {
        throw new Error(
            `[patchcordAppAudio] Failed to download ${assetName}: HTTP ${res.status}. ` +
            `No prebuilt release exists upstream yet -- build it yourself and place it at ${file}`
        );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    await chmod(file, 0o755);
    return file;
}

async function ensureBinary(): Promise<string> {
    return downloadAsset(binaryName(), PATCHCORD_RELEASE_URL_BASE);
}

async function initPatchcord() {
    if (patchbay) return;
    try {
        const command = await ensureBinary();
        // No sink/mic options: the discord_capture direct-link path
        // creates no virtual audio objects of its own (see this file's
        // module doc comment for why).
        patchbay = new AudioSharePatchbay({ command });
        hasPipewirePulse = await patchbay.hasPipeWire();
    } catch (e) {
        console.error("[patchcordAppAudio] Failed to init patchcord", e);
        hasPipewirePulse = false;
    }
    // Best-effort: without discord-capture-shim actually LD_PRELOAD'd/
    // DT_NEEDED'd into discord_voice.node, Discord's own autoconnect
    // keeps linking every detected app regardless of what patchcord does
    // (see this file's top doc comment) -- so this needs to run whether
    // or not patchcord itself initialized successfully.
    void ensureDiscordCaptureShimInstalled().catch(e => {
        console.error("[patchcordAppAudio] Failed to install discord-capture-shim", e);
    });
}

/**
 * SHIM_RELEASE_URL_BASE points at the same repo/release as patchcord's
 * own binary (see PATCHCORD_RELEASE_URL_BASE) -- discord-capture-shim
 * lives in the same Cargo workspace (~/Code/patchcord/crates/
 * discord-capture-shim) and is published as two extra assets on
 * patchcord's own GitHub release rather than a separate repo/release
 * cycle, since the two are versioned and shipped together in lockstep
 * (this plugin always wants a shim built from the exact same commit as
 * the patchcord binary it's running).
 */
const SHIM_RELEASE_URL_BASE = PATCHCORD_RELEASE_URL_BASE;

function shimAssetNames(): { shimSo: string; setupBin: string } {
    const arch = process.arch; // already validated by binaryName()
    return {
        shimSo: `discord-capture-shim-linux-${arch}.so`,
        setupBin: `discord-capture-setup-linux-${arch}`,
    };
}

/**
 * Ensures `discord-capture-shim.so` is downloaded and DT_NEEDED'd into
 * every installed Discord release channel's `discord_voice.node`, using
 * `discord-capture-setup` (a small companion binary, see its own doc
 * comment in ~/Code/patchcord/crates/discord-capture-shim/src/bin/setup.rs)
 * instead of shelling out to the system `patchelf` package -- this is
 * the distribution mechanism decided on this session after the
 * "dual-purpose ELF" investigation concluded a single self-patching file
 * isn't possible on glibc (PT_INTERP and dlopen/DT_NEEDED-loadability
 * are mutually exclusive on one ELF file).
 *
 * Both downloaded files are named per-arch on the release (see
 * shimAssetNames()), same convention as patchcord's own binaryName().
 * The downloaded `discord-capture-shim.so` is renamed to the exact
 * literal soname discord_voice.node's DT_NEEDED entry looks for
 * ("discord-capture-shim.so", no arch/version suffix -- see setup.rs's
 * SHIM_SONAME) once in place in binaryDir(), so a single stable RUNPATH
 * entry (binaryDir() itself) resolves it regardless of which arch build
 * was actually downloaded.
 *
 * Runs `discord-capture-setup` against every discord_voice.node found
 * under any installed Discord release channel's config directory (see
 * findDiscordVoiceNodePaths()), not just the currently-running one --
 * this plugin's own process only knows about the channel it's actually
 * running inside, but the user may switch channels (Stable/PTB/Canary)
 * or Discord may install a new version dir on the next auto-update, and
 * a not-yet-patched discord_voice.node silently means "shim inactive,
 * every detected app leaks through" with no user-visible signal (per
 * this file's own top doc comment) -- so it's much safer to patch every
 * one found than to patch only the one currently in use.
 *
 * Idempotent (discord-capture-setup itself no-ops on an
 * already-patched file), so calling this on every plugin start is safe
 * and cheap; it's also re-run after every Discord auto-update replaces
 * discord_voice.node with a fresh, unpatched copy.
 */
async function ensureDiscordCaptureShimInstalled(): Promise<void> {
    if (process.platform !== "linux") return;

    const { shimSo, setupBin } = shimAssetNames();
    const [shimSrc, setupPath] = await Promise.all([
        downloadAsset(shimSo, SHIM_RELEASE_URL_BASE),
        downloadAsset(setupBin, SHIM_RELEASE_URL_BASE),
    ]);

    const shimDir = binaryDir();
    const shimDest = join(shimDir, "discord-capture-shim.so");
    if (!existsSync(shimDest)) {
        await copyFile(shimSrc, shimDest);
        await chmod(shimDest, 0o755);
    }

    const voiceNodePaths = await findDiscordVoiceNodePaths();
    if (voiceNodePaths.length === 0) {
        console.warn("[patchcordAppAudio] No discord_voice.node found under any Discord config directory; cannot install discord-capture-shim.");
        return;
    }

    for (const voiceNodePath of voiceNodePaths) {
        try {
            const { stdout } = await execFileAsync(setupPath, [voiceNodePath, shimDir]);
            console.log(`[patchcordAppAudio] ${stdout.trim()}`);
        } catch (e) {
            console.error(`[patchcordAppAudio] discord-capture-setup failed for ${voiceNodePath}`, e);
        }
    }
}

/**
 * Discord's own config-directory layout (`~/.config/discord*`,
 * `~/.var/app/com.discordapp.*` for Flatpak) puts each installed
 * version's native modules somewhere under `<configDir>/<version>/
 * modules/` -- but the exact nesting under `modules/` genuinely varies
 * live between installs on this machine: PTB and the Flatpak Canary
 * build have `modules/discord_voice/discord_voice.node` directly, while
 * this machine's Stable install nests one level deeper,
 * `modules/discord_voice-1/discord_voice/discord_voice.node`. Rather
 * than hardcode either shape (and risk silently missing a third one on
 * some other install), this walks the whole `modules/` subtree
 * (bounded depth, modules directories are never more than a couple
 * levels deep) looking for any directory matching `discord_voice(-\d+)?`
 * and then any `discord_voice.node` file anywhere under *that*.
 *
 * Scans every `discord*`-named sibling of the current config dir
 * (covers Stable, PTB, Canary, Development running side-by-side) rather
 * than assuming only the currently-running channel matters (see
 * ensureDiscordCaptureShimInstalled's doc comment for why).
 */
async function findDiscordVoiceNodePaths(): Promise<string[]> {
    const configRoot = dirname(app.getPath("userData")); // e.g. ~/.config
    const found: string[] = [];

    let siblings: string[];
    try {
        siblings = await readdir(configRoot);
    } catch {
        return found;
    }

    for (const sibling of siblings) {
        if (!/discord/i.test(sibling)) continue;
        const channelDir = join(configRoot, sibling);

        let versionDirs: string[];
        try {
            versionDirs = await readdir(channelDir);
        } catch {
            continue;
        }

        for (const versionDir of versionDirs) {
            const modulesDir = join(channelDir, versionDir, "modules");
            let moduleDirs: string[];
            try {
                moduleDirs = await readdir(modulesDir);
            } catch {
                continue;
            }
            for (const moduleDir of moduleDirs) {
                if (!/^discord_voice(-\d+)?$/.test(moduleDir)) continue;
                found.push(...await findVoiceNodeUnder(join(modulesDir, moduleDir), 3));
            }
        }
    }

    return found;
}

/** Bounded-depth recursive search for `discord_voice.node` files. */
async function findVoiceNodeUnder(dir: string, maxDepth: number): Promise<string[]> {
    if (maxDepth < 0) return [];
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (entry === "discord_voice.node") {
            found.push(full);
        } else {
            try {
                if (statSync(full).isDirectory()) {
                    found.push(...await findVoiceNodeUnder(full, maxDepth - 1));
                }
            } catch {
                // ignore unreadable entries
            }
        }
    }
    return found;
}

export async function hasPipeWire(_: Electron.IpcMainInvokeEvent) {
    await initPatchcord();
    return hasPipewirePulse;
}

export async function listShareableNodes(_: Electron.IpcMainInvokeEvent, includeDevices = false): Promise<ShareableNode[]> {
    await initPatchcord();
    if (!patchbay) return [];
    return patchbay.listShareableNodes(includeDevices);
}

/**
 * Best-effort correlation of an in-progress KDE/KWin window-share with a
 * likely audio-producing app; see the `ScreencastHint` doc comment in
 * patchcordClient.d.ts / patchcord's src/patchbay/models.rs for the
 * mechanism. Returns null when there's no active window share or the
 * compositor isn't KWin -- the picker treats that as "no hint available"
 * and shows the full unfiltered list, not an error.
 */
export async function findScreencastHint(_: Electron.IpcMainInvokeEvent): Promise<ScreencastHint | null> {
    await initPatchcord();
    if (!patchbay || !hasPipewirePulse) return null;
    try {
        return await patchbay.findScreencastHint();
    } catch (e) {
        console.warn("[patchcordAppAudio] findScreencastHint failed (non-fatal)", e);
        return null;
    }
}

/**
 * Routes the given node ids' audio directly into every live
 * `discord_capture` node (Discord's own per-app screenshare-audio
 * capture, not a virtual sink/mic) via patchcord's
 * `setDiscordCaptureTargets`. Accepts multiple node ids (for multi-app /
 * "Entire System minus excluded apps" selection -- see index.tsx's
 * ModalComponent) and patchcord's RouteFilter, applied server-side with
 * the identical `should_link` decision `routeNodes` uses. Pass an empty
 * array to stop routing anything (used for "None"/"Skip").
 *
 * `groupApplicationNames`, if given, is the set of `applicationName`
 * values (e.g. "Firefox") the caller wants *every* current and future
 * node from -- not just the specific node ids the user actually clicked
 * in the picker. This plugin's own `graphChanged` listener (installed
 * below) re-derives the full target node id list from this set on every
 * graph change for as long as routing stays active, so a new tab/window
 * the grouped app opens later gets included automatically without the
 * user needing to reopen the picker. Pass `undefined`/omit for the old
 * exact-node-ids-only behavior.
 *
 * Unlike the old mic-swap approach, there's no device to resolve or
 * return here: this call's success/failure *is* the whole result --
 * once it resolves, the requested app(s)' audio either is or isn't
 * reaching discord_capture, with nothing further for the renderer to
 * do.
 */
export async function startAppAudio(
    _: Electron.IpcMainInvokeEvent,
    nodeIds: number[],
    filter: RouteFilter = {},
    groupApplicationNames?: string[]
): Promise<boolean> {
    await initPatchcord();
    if (!patchbay || !hasPipewirePulse) return false;

    try {
        activeExplicitNodeIds = nodeIds;
        activeFilter = filter;
        activeGroupApplicationNames = groupApplicationNames && groupApplicationNames.length > 0
            ? new Set(groupApplicationNames)
            : null;
        ensureGraphChangedListener();

        const targets = await resolveTargetNodeIds();
        await patchbay.setDiscordCaptureTargets(targets, filter);
        return true;
    } catch (e) {
        console.error("[patchcordAppAudio] Failed to start app audio routing", e);
        return false;
    }
}

let activeExplicitNodeIds: number[] = [];
let activeFilter: RouteFilter = {};
let activeGroupApplicationNames: Set<string> | null = null;
let graphChangedListenerInstalled = false;

/**
 * Combines the user's explicitly-picked node ids with every *current*
 * node belonging to a grouped application (see `startAppAudio`'s own doc
 * comment). Recomputed fresh on every call rather than cached, since the
 * whole point is picking up nodes that didn't exist yet the last time
 * this ran.
 */
async function resolveTargetNodeIds(): Promise<number[]> {
    const ids = new Set(activeExplicitNodeIds);
    if (activeGroupApplicationNames && activeGroupApplicationNames.size > 0 && patchbay) {
        const allNodes = await patchbay.listShareableNodes(false);
        for (const node of allNodes) {
            if (node.applicationName && activeGroupApplicationNames.has(node.applicationName)) {
                ids.add(node.id);
            }
        }
    }
    return [...ids];
}

/**
 * Installed once, lazily, the first time app-audio routing actually
 * starts (not at plugin-init time, so an idle patchcord instance that's
 * never routed anything doesn't carry a listener for nothing). Re-syncs
 * `discord_capture` targets on every graph change so a grouped app's
 * newly-opened node (e.g. a new Firefox tab) gets picked up without the
 * user reopening the picker. A no-op whenever no group is active --
 * `resolveTargetNodeIds` just returns `activeExplicitNodeIds` unchanged
 * in that case, and re-sending an unchanged target list to patchcord is
 * cheap (`sync_discord_capture_links` itself is already a no-op when
 * nothing's actually different).
 */
function ensureGraphChangedListener() {
    if (graphChangedListenerInstalled || !patchbay) return;
    graphChangedListenerInstalled = true;
    patchbay.on("graphChanged", async () => {
        if (!patchbay || activeExplicitNodeIds.length === 0) return;
        try {
            const targets = await resolveTargetNodeIds();
            await patchbay.setDiscordCaptureTargets(targets, activeFilter);
        } catch (e) {
            console.error("[patchcordAppAudio] Failed to re-sync grouped app-audio targets on graph change", e);
        }
    });
}

export async function stopAppAudio(_?: Electron.IpcMainInvokeEvent) {
    if (!patchbay) return;
    activeExplicitNodeIds = [];
    activeGroupApplicationNames = null;
    // Clear discord_capture links, not a full patchbay dispose: dispose()
    // tears down virtual sink/mic bookkeeping this path never creates,
    // and (more importantly) destroying the whole patchbay instance here
    // would force a full patchcord respawn on the next share rather than
    // just clearing the current routing.
    await patchbay.setDiscordCaptureTargets([]).catch(() => {});
}

app.on("before-quit", () => {
    if (patchbay) {
        patchbay.dispose().catch(() => {});
    }
});
