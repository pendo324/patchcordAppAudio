/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Main-process bridge to `patchcord`, the native PipeWire helper already
 * built and verified in this session (see ~/Code/patchcord). Spawns it,
 * exposes listShareableNodes/ensureVirtualSink/routeNodes/dispose to the
 * renderer via pluginHelpers, same shape as GoofCord's
 * src/modules/native/patchcord.ts.
 *
 * Deliberately does NOT use patchcord's sink_becomes_default /
 * setDefaultSinkToVirtual: live testing during development showed that
 * making the virtual sink the system default causes every app currently
 * playing audio to also follow it there (that's what "default sink" means
 * to PipeWire/WirePlumber), which defeats the point of app-only audio.
 * Instead this plugin never touches the system default at all -- it
 * relies on the renderer side swapping the audio track of Discord's own
 * getDisplayMedia() result for one pulled from patchcord's virtual mic
 * device, exactly like GoofCord's screensharePatch.ts already does.
 */

import { app } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod } from "fs/promises";

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
 */
const PATCHCORD_RELEASE_URL_BASE = "https://github.com/Milkshiift/patchcord/releases/latest/download";

async function ensureBinary(): Promise<string> {
    const dir = binaryDir();
    const file = join(dir, binaryName());
    if (existsSync(file)) return file;

    await mkdir(dir, { recursive: true });
    const url = `${PATCHCORD_RELEASE_URL_BASE}/${binaryName()}`;
    console.log("[patchcordAppAudio] Downloading patchcord binary from", url);

    let res: Response;
    try {
        res = await fetch(url);
    } catch (e) {
        throw new Error(
            `[patchcordAppAudio] Failed to download patchcord (network error): ${(e as Error).message}. ` +
            `No prebuilt release exists upstream yet -- build it yourself and place the binary at ${file}`
        );
    }
    if (!res.ok) {
        throw new Error(
            `[patchcordAppAudio] Failed to download patchcord: HTTP ${res.status}. ` +
            `No prebuilt release exists upstream yet -- build it yourself and place the binary at ${file}`
        );
    }

    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
    await chmod(file, 0o755);
    return file;
}

async function initPatchcord() {
    if (patchbay) return;
    try {
        const command = await ensureBinary();
        patchbay = new AudioSharePatchbay({
            command,
            sinkPrefix: "equicord-app-audio",
            sinkDescription: "Equicord App Audio Share",
            virtualMic: true,
            virtualMicName: "equicord-app-audio-mic",
            virtualMicDescription: "Equicord-App-Audio-Virtual-Mic",
        });
        hasPipewirePulse = await patchbay.hasPipeWire();
    } catch (e) {
        console.error("[patchcordAppAudio] Failed to init patchcord", e);
        hasPipewirePulse = false;
    }
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
 * Routes the given node ids' audio into the virtual sink and returns the
 * virtual mic's device description, which the renderer matches against
 * `enumerateDevices()` labels to find the swap-in device (identical
 * pattern to GoofCord's getVirtmic()). Accepts multiple node ids (for
 * multi-app / "Entire System minus excluded apps" selection -- see
 * index.tsx's ModalComponent) and an optional RouteFilter, both passed
 * straight through to patchcord's own `routeNodes`, which already
 * implements this filtering on the Rust side (see patchbay/state_native.rs
 * `should_link`) -- nothing to reimplement here.
 */
export async function startAppAudio(
    _: Electron.IpcMainInvokeEvent,
    nodeIds: number[],
    filter: RouteFilter = {}
): Promise<string | null> {
    await initPatchcord();
    if (!patchbay || !hasPipewirePulse) return null;

    try {
        const sinkInfo = await patchbay.ensureVirtualSink();
        await patchbay.routeNodes(nodeIds, filter);
        return sinkInfo.virtualMicDescription ?? null;
    } catch (e) {
        console.error("[patchcordAppAudio] Failed to start app audio routing", e);
        return null;
    }
}

export async function stopAppAudio(_?: Electron.IpcMainInvokeEvent) {
    if (!patchbay) return;
    await patchbay.dispose().catch(() => {});
}

app.on("before-quit", () => {
    stopAppAudio();
});
