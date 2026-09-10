/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";

import * as consentGate from "./native/consentGate";
import * as fsQuery from "./native/fsQuery";
import type { AssetRecord } from "./native/nativeAssetStore";
import * as nativeAssetStore from "./native/nativeAssetStore";
import * as nativeProcess from "./native/nativeProcess";

const PLUGIN_NAME = "PatchcordAppAudio";

// --- consentGate passthrough -------------------------------------------------

export async function hasConsented(_: Electron.IpcMainInvokeEvent, assetName: string, sha256: string) {
    return consentGate.hasConsented(assetName, sha256);
}

export async function recordConsent(_: Electron.IpcMainInvokeEvent, assetName: string, sha256: string) {
    return consentGate.recordConsent(assetName, sha256);
}

export async function revokeConsent(_: Electron.IpcMainInvokeEvent, assetName: string, sha256: string) {
    return consentGate.revokeConsent(assetName, sha256);
}

export async function getAutoApproveNativeDownloads(_?: Electron.IpcMainInvokeEvent) {
    return consentGate.getAutoApprove();
}

export async function setAutoApproveNativeDownloads(_: Electron.IpcMainInvokeEvent, value: boolean) {
    return consentGate.setAutoApprove(value);
}

// --- nativeAssetStore passthrough --------------------------------------------

export async function ensureAsset(_: Electron.IpcMainInvokeEvent, assetName: string, releaseUrlBase: string) {
    return nativeAssetStore.ensureAsset(assetName, releaseUrlBase);
}

export async function getAssetStoreDir(_?: Electron.IpcMainInvokeEvent) {
    return nativeAssetStore.assetStoreDir();
}

// --- nativeProcess passthrough -----------------------------------------------

export async function runOnce(_: Electron.IpcMainInvokeEvent, asset: AssetRecord, args: string[]) {
    return nativeProcess.runOnce(asset, args);
}

export async function spawnPersistent(_: Electron.IpcMainInvokeEvent, asset: AssetRecord, args: string[]) {
    return nativeProcess.spawnPersistent({ pluginName: PLUGIN_NAME }, asset, args);
}

export async function writeProcessLine(_: Electron.IpcMainInvokeEvent, handleId: number, text: string) {
    return nativeProcess.writeLine(handleId, text);
}

export async function disposeProcess(_: Electron.IpcMainInvokeEvent, handleId: number, graceMs?: number) {
    nativeProcess.disposeProcess(handleId, graceMs);
}

// --- fsQuery passthrough ------------------------------------------------------

export async function getHostExecutableDir(_?: Electron.IpcMainInvokeEvent) {
    return fsQuery.getHostExecutableDir();
}

export async function getArch(_?: Electron.IpcMainInvokeEvent) {
    return fsQuery.getArch();
}

/**
 * `namePatternSource`/`namePatternFlags` rather than a `RegExp` directly
 * -- `RegExp` instances don't survive Electron's IPC structured-clone
 * boundary as `RegExp` (they'd arrive as a plain object with no `test`
 * method), so the renderer sends the pattern as its literal source/flags
 * strings and this reconstructs it here.
 */
export async function findFiles(_: Electron.IpcMainInvokeEvent, baseDir: string, namePatternSource: string, namePatternFlags: string, maxDepth: number) {
    return fsQuery.findFiles(baseDir, new RegExp(namePatternSource, namePatternFlags), maxDepth);
}

export async function joinPath(_: Electron.IpcMainInvokeEvent, ...segments: string[]) {
    return fsQuery.joinPath(...segments);
}

export async function fileContainsBytes(_: Electron.IpcMainInvokeEvent, path: string, needleUtf8: string) {
    return fsQuery.fileContainsBytes(path, needleUtf8);
}

// --- lifecycle -----------------------------------------------------------------

app.on("before-quit", () => {
    nativeProcess.disposeAll();
});
