/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { emitPluginNativeEvent } from "@main/ipcPlugins";
import { ChildProcess,execFile, spawn } from "child_process";
import { createInterface } from "readline";
import { promisify } from "util";

import type { AssetRecord } from "./nativeAssetStore";
import * as nativeAssetStore from "./nativeAssetStore";

const execFileAsync = promisify(execFile);

/**
 * `pluginName` is passed in by `native.ts` (the one place that knows
 * this plugin's own registered name) rather than hardcoded here, so
 * this module has zero references to "PatchcordAppAudio" anywhere in
 * its own source -- keeping it usable verbatim by any other plugin.
 */
export interface NativeProcessConfig {
    pluginName: string;
}

export type RunOnceResult =
    | { ok: true; stdout: string; stderr: string }
    | { ok: false; reason: "not_verified"; message: string }
    | { ok: false; reason: "exec_failed"; message: string };

/**
 * Runs `asset` once with `args`, waits for exit, and returns its
 * captured stdout/stderr. Re-verifies the asset (see this module's own
 * doc comment) immediately before exec.
 */
export async function runOnce(asset: AssetRecord, args: string[]): Promise<RunOnceResult> {
    const verified = await nativeAssetStore.reverifyAsset(asset);
    if (!verified.ok) {
        return { ok: false, reason: "not_verified", message: verified.reason };
    }

    try {
        const { stdout, stderr } = await execFileAsync(verified.path, args);
        return { ok: true, stdout, stderr };
    } catch (e) {
        return { ok: false, reason: "exec_failed", message: (e as Error).message };
    }
}

interface PersistentHandle {
    child: ChildProcess;
    pluginName: string;
}

let nextHandleId = 1;
const handles = new Map<number, PersistentHandle>();

export type SpawnPersistentResult =
    | { ok: true; handleId: number }
    | { ok: false; reason: "not_verified"; message: string }
    | { ok: false; reason: "spawn_failed"; message: string };

/**
 * Spawns `asset` with `args` as a long-lived subprocess. Re-verifies the
 * asset immediately before spawning, same as `runOnce`. Every stdout
 * line is forwarded opaquely to the renderer as
 * `emitPluginNativeEvent(pluginName, "line", handleId, lineText)`;
 * process exit is forwarded as
 * `emitPluginNativeEvent(pluginName, "exit", handleId, code, signal)`.
 * stderr is inherited (visible in the host Discord process's own
 * stderr/logs) rather than captured or forwarded -- there is no
 * renderer-side consumer for it in the current design, and capturing it
 * unbounded for a long-lived process risks unbounded memory growth for
 * no current benefit.
 */
export async function spawnPersistent(config: NativeProcessConfig, asset: AssetRecord, args: string[]): Promise<SpawnPersistentResult> {
    const verified = await nativeAssetStore.reverifyAsset(asset);
    if (!verified.ok) {
        return { ok: false, reason: "not_verified", message: verified.reason };
    }

    let child: ChildProcess;
    try {
        child = spawn(verified.path, args, { stdio: ["pipe", "pipe", "inherit"] });
    } catch (e) {
        return { ok: false, reason: "spawn_failed", message: (e as Error).message };
    }

    const handleId = nextHandleId++;
    handles.set(handleId, { child, pluginName: config.pluginName });

    if (child.stdout) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", line => {
            emitPluginNativeEvent(config.pluginName, "line", handleId, line);
        });
    }

    child.on("exit", (code, signal) => {
        emitPluginNativeEvent(config.pluginName, "exit", handleId, code, signal);
        handles.delete(handleId);
    });
    child.on("error", err => {
        emitPluginNativeEvent(config.pluginName, "error", handleId, (err as Error).message);
    });

    return { ok: true, handleId };
}

/** Writes one line (a trailing `\n` is added) to `handleId`'s stdin. Opaque -- no framing/parsing of any kind. */
export function writeLine(handleId: number, text: string): boolean {
    const handle = handles.get(handleId);
    if (!handle?.child.stdin || handle.child.stdin.destroyed) return false;
    handle.child.stdin.write(`${text}\n`);
    return true;
}

/** Sends SIGTERM (escalating to SIGKILL after `graceMs`) and removes the handle. Safe to call on an already-dead handle. */
export function disposeProcess(handleId: number, graceMs = 2000): void {
    const handle = handles.get(handleId);
    if (!handle) return;
    handle.child.stdin?.end();
    handle.child.kill("SIGTERM");
    setTimeout(() => {
        if (handles.has(handleId)) {
            try { handle.child.kill("SIGKILL"); } catch { /* already dead */ }
        }
    }, graceMs).unref();
}

/** Disposes every currently-tracked persistent handle -- for use on app quit. */
export function disposeAll(): void {
    for (const handleId of [...handles.keys()]) disposeProcess(handleId, 500);
}
