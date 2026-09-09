/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative, PluginNativeEvents } from "@utils/types";

import { AudioSharePatchbay, type NativeHandle,type RouteFilter, type ScreencastHint, type ShareableNode } from "./patchcordClient";

export type Native = PluginNative<typeof import("./native")> & PluginNativeEvents;

function arch(): "x64" | "arm64" {
    if (process.arch !== "x64" && process.arch !== "arm64") {
        throw new Error(`patchcordAppAudio only supports x64/arm64 (got ${process.arch})`);
    }
    return process.arch;
}

/**
 * Points at a specific tagged release rather than `/releases/latest/
 * download`: the current release is a prerelease (`v0.1.0-rc.1`), and
 * GitHub's `/latest` alias only ever resolves to the newest *non*
 * prerelease -- it 404s while every published release is a prerelease.
 * Bump this tag when a new release is cut.
 *
 * `PATCHCORD_APP_AUDIO_RELEASE_URL_BASE`, if set (renderer environment,
 * e.g. injected via Electron's own env at launch), overrides where every
 * downloadable asset is fetched from -- used for local testing against
 * a throwaway HTTP server serving freshly-built binaries.
 */
const DEFAULT_RELEASE_URL_BASE = "https://github.com/pendo324/patchcord/releases/download/v0.1.0-rc.1";
export function releaseUrlBase(): string {
    return (typeof process !== "undefined" && process.env?.PATCHCORD_APP_AUDIO_RELEASE_URL_BASE) || DEFAULT_RELEASE_URL_BASE;
}

export function assetNames() {
    const a = arch();
    return {
        patchcord: `patchcord-linux-${a}`,
        shimSo: `discord-capture-shim-linux-${a}.so`,
        setupBin: `discord-capture-setup-linux-${a}`,
    };
}

function makeNativeHandle(native: Native): NativeHandle {
    return {
        invoke: (method, ...args) => (native as any)[method](...args),
        on: (eventName, cb) => native.on(eventName, cb),
    };
}

let patchbay: AudioSharePatchbay | undefined;

export type EnsurePatchcordResult =
    | { ok: true; patchbay: AudioSharePatchbay }
    | { ok: false; reason: string;[key: string]: any };

/**
 * Ensures a patchcord process is running, starting one (consent-gated,
 * see AudioSharePatchbay.start's own doc comment) if not already. Safe
 * to call repeatedly -- reuses the existing instance.
 */
export async function ensurePatchcord(native: Native): Promise<EnsurePatchcordResult> {
    if (patchbay) return { ok: true, patchbay };

    const instance = new AudioSharePatchbay(makeNativeHandle(native), {
        assetName: assetNames().patchcord,
        releaseUrlBase: releaseUrlBase(),
    });
    const result = await instance.start();
    if (!result.ok) return result;

    patchbay = instance;
    return { ok: true, patchbay: instance };
}

export function disposePatchcord() {
    if (patchbay) {
        patchbay.dispose().catch(() => {});
        patchbay = undefined;
    }
}

export async function hasPipeWire(native: Native): Promise<boolean> {
    const ensured = await ensurePatchcord(native);
    if (!ensured.ok) return false;
    try {
        return await ensured.patchbay.hasPipeWire();
    } catch {
        return false;
    }
}

export async function listShareableNodes(native: Native, includeDevices = false): Promise<ShareableNode[]> {
    const ensured = await ensurePatchcord(native);
    if (!ensured.ok) return [];
    try {
        return await ensured.patchbay.listShareableNodes(includeDevices);
    } catch {
        return [];
    }
}

export async function findScreencastHint(native: Native): Promise<ScreencastHint | null> {
    const ensured = await ensurePatchcord(native);
    if (!ensured.ok) return null;
    try {
        return await ensured.patchbay.findScreencastHint();
    } catch {
        return null;
    }
}

// --- app-audio routing (discord_capture direct-link) -------------------------

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
 * starts. Re-syncs `discord_capture` targets on every graph change so a
 * grouped app's newly-opened node (e.g. a new Firefox tab) gets picked
 * up without the user reopening the picker. A no-op whenever no group
 * is active.
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

/**
 * Routes the given node ids' audio directly into every live
 * `discord_capture` node. `groupApplicationNames`, if given, is the set
 * of `applicationName` values (e.g. "Firefox") to keep including every
 * current/future node from -- see `ensureGraphChangedListener`.
 */
export async function startAppAudio(
    native: Native,
    nodeIds: number[],
    filter: RouteFilter = {},
    groupApplicationNames?: string[]
): Promise<boolean> {
    const ensured = await ensurePatchcord(native);
    if (!ensured.ok) return false;

    try {
        activeExplicitNodeIds = nodeIds;
        activeFilter = filter;
        activeGroupApplicationNames = groupApplicationNames && groupApplicationNames.length > 0
            ? new Set(groupApplicationNames)
            : null;
        ensureGraphChangedListener();

        const targets = await resolveTargetNodeIds();
        await ensured.patchbay.setDiscordCaptureTargets(targets, filter);
        return true;
    } catch (e) {
        console.error("[patchcordAppAudio] Failed to start app audio routing", e);
        return false;
    }
}

export async function stopAppAudio(): Promise<void> {
    if (!patchbay) return;
    activeExplicitNodeIds = [];
    activeGroupApplicationNames = null;
    // Clear discord_capture links, not a full patchbay dispose: dispose()
    // would force a full patchcord respawn on the next share rather than
    // just clearing the current routing.
    await patchbay.setDiscordCaptureTargets([]).catch(() => {});
}

// --- discord-capture-shim install/restore -----------------------------------

const DISCORD_VOICE_MODULE_PATTERN_SOURCE = "^discord_voice(-\\d+)?$";
const DISCORD_VOICE_NODE_PATTERN_SOURCE = "^discord_voice\\.node$";
const DISCORD_VOICE_MODULE_MAX_DEPTH = 3;

/**
 * Finds `discord_voice.node` under the Discord install this renderer is
 * actually running inside -- deliberately scoped to just this one
 * install (installing/consenting from one Discord channel should never
 * touch a completely separate install's files, e.g. Stable vs. PTB vs.
 * Canary). `getHostExecutableDir()`'s directory is the version dir
 * (same resolution Equicord core's own hostUpdateHook.ts uses for an
 * unrelated purpose), so `modules/` is always a direct sibling of the
 * running executable regardless of which channel/install this is.
 *
 * The exact nesting under `modules/` genuinely varies live between
 * installs (some have `modules/discord_voice/discord_voice.node`
 * directly, others nest one level deeper,
 * `modules/discord_voice-1/discord_voice/discord_voice.node`) -- rather
 * than hardcode either shape, this asks native.ts's generic `findFiles`
 * to search the whole `modules/` subtree (bounded depth) for any
 * `discord_voice.node` file, having first narrowed to only the
 * `discord_voice(-\d+)?`-named module directories.
 */
async function findDiscordVoiceNodePaths(native: Native): Promise<string[]> {
    const versionDir: string = await native.getHostExecutableDir();
    const modulesDir: string = await native.joinPath(versionDir, "modules");

    const moduleDirs: string[] = await native.findFiles(modulesDir, DISCORD_VOICE_MODULE_PATTERN_SOURCE, "", 0);

    const found: string[] = [];
    for (const moduleDir of moduleDirs) {
        found.push(...await native.findFiles(moduleDir, DISCORD_VOICE_NODE_PATTERN_SOURCE, "", DISCORD_VOICE_MODULE_MAX_DEPTH));
    }
    return found;
}

export interface ShimStatus {
    supported: boolean;
    /**
     * Best-effort, non-authoritative: a plain byte-substring probe (see
     * fsQuery.fileContainsBytes) for "discord-capture-shim.so" appearing
     * anywhere in the file, not a real ELF DT_NEEDED parse. Good enough
     * to decide whether to show the install prompt at all; the actual
     * install/restore actions rely on discord-capture-setup's own real
     * ELF-aware idempotency check, not this.
     */
    alreadyInstalled: boolean;
    voiceNodePaths: string[];
}

/** Read-only: does not download or execute anything (one plain file read per discord_voice.node found). */
export async function getShimStatus(native: Native): Promise<ShimStatus> {
    if (process.platform !== "linux") return { supported: false, alreadyInstalled: false, voiceNodePaths: [] };

    const voiceNodePaths = await findDiscordVoiceNodePaths(native);
    if (voiceNodePaths.length === 0) return { supported: true, alreadyInstalled: false, voiceNodePaths: [] };

    let alreadyInstalled = true;
    for (const p of voiceNodePaths) {
        if (!await native.fileContainsBytes(p, "discord-capture-shim.so")) {
            alreadyInstalled = false;
            break;
        }
    }

    return { supported: true, alreadyInstalled, voiceNodePaths };
}

export type ShimActionResult =
    | { ok: true; message: string }
    | { ok: false; message: string }
    | { ok: false; reason: "not_consented"; assetName: string; sha256: string };

function toShimActionResult(r: { ok: false; reason: string;[k: string]: any }): ShimActionResult {
    if (r.reason === "not_consented") return r as ShimActionResult;
    return { ok: false, message: `${r.reason}: ${r.message ?? ""}`.trim() };
}

/**
 * Ensures both discord-capture-shim.so and discord-capture-setup are
 * downloaded/consented, then runs discord-capture-setup once per
 * discord_voice.node found (see findDiscordVoiceNodePaths). If either
 * asset needs consent, returns that result immediately without running
 * anything -- the caller should show a consent prompt, call
 * `native.recordConsent`, then call this again.
 */
export async function installShim(native: Native): Promise<ShimActionResult> {
    if (process.platform !== "linux") return { ok: false, message: "discord-capture-shim only supports Linux." };

    const { shimSo, setupBin } = assetNames();
    const url = releaseUrlBase();

    const shimResult = await native.ensureAsset(shimSo, url);
    if (!shimResult.ok) return toShimActionResult(shimResult);

    const setupResult = await native.ensureAsset(setupBin, url);
    if (!setupResult.ok) return toShimActionResult(setupResult);

    const voiceNodePaths = await findDiscordVoiceNodePaths(native);
    if (voiceNodePaths.length === 0) {
        return { ok: false, message: "No discord_voice.node found under the running Discord install." };
    }

    // discord-capture-setup needs the directory discord-capture-shim.so
    // actually lives in (to write into RUNPATH) -- every asset lives in
    // the one directory native.ts's asset store uses, so this is just
    // re-deriving that same constant, not a separate/parallel concept.
    const shimDir: string = await native.getAssetStoreDir();

    const results: string[] = [];
    let anyFailed = false;
    for (const voiceNodePath of voiceNodePaths) {
        const runResult = await native.runOnce(setupResult.asset, [voiceNodePath, shimDir]);
        if (runResult.ok) {
            results.push(runResult.stdout.trim());
        } else {
            anyFailed = true;
            results.push(`FAILED for ${voiceNodePath}: ${runResult.message}`);
        }
    }

    return anyFailed
        ? { ok: false, message: results.join("\n") }
        : { ok: true, message: results.join("\n") };
}

/** Restores every discord_voice.node this plugin has previously patched back to its pre-patch original. */
export async function restoreShim(native: Native): Promise<ShimActionResult> {
    if (process.platform !== "linux") return { ok: false, message: "discord-capture-shim only supports Linux." };

    const { setupBin } = assetNames();
    const url = releaseUrlBase();

    const setupResult = await native.ensureAsset(setupBin, url);
    if (!setupResult.ok) return toShimActionResult(setupResult);

    const voiceNodePaths = await findDiscordVoiceNodePaths(native);
    const results: string[] = [];
    let anyFailed = false;
    for (const voiceNodePath of voiceNodePaths) {
        const runResult = await native.runOnce(setupResult.asset, ["--restore", voiceNodePath]);
        if (runResult.ok) {
            results.push(runResult.stdout.trim());
        } else {
            anyFailed = true;
            results.push(`FAILED for ${voiceNodePath}: ${runResult.message}`);
        }
    }

    return anyFailed
        ? { ok: false, message: results.join("\n") }
        : { ok: true, message: results.join("\n") };
}

export type { RouteFilter,ScreencastHint, ShareableNode };
