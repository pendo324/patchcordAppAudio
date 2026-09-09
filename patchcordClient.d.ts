/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EventEmitter } from "node:events";

export interface ShareableNode {
    id: number;
    displayName: string;
    applicationName: string | null;
    nodeName: string | null;
    description: string | null;
    mediaName: string | null;
    binary: string | null;
    processId: number | null;
    isDevice: boolean;
    mediaClass: string | null;
    isVirtual: boolean;
}

export interface RouteFilter {
    onlySpeakers?: boolean;
    onlyDefaultSpeakers?: boolean;
    ignoreDevices?: boolean;
    ignoreVirtual?: boolean;
    ignoreInputMedia?: boolean;
}

/**
 * A best-effort hint correlating an in-progress KDE/KWin window-share
 * (portal ScreenCast session) with a likely audio-producing app, derived
 * from KWin's own PipeWire video node naming convention. See the Rust
 * `models::ScreencastHint` doc comment for the full mechanism. `null`
 * (from `findScreencastHint()`) is the normal case when no window share
 * is active or the compositor isn't KWin -- callers should fall back to
 * showing the full unfiltered node list, not treat it as an error.
 */
export interface ScreencastHint {
    desktopFileId: string;
    hint: string;
}

/**
 * The generic native.ts IPC surface this client drives (a subset of
 * `VencordNative.pluginHelpers.PatchcordAppAudio`), passed in explicitly
 * rather than imported directly -- see patchcordClient.js's own doc
 * comment for why.
 */
export interface NativeHandle {
    invoke(method: string, ...args: any[]): Promise<any>;
    on(eventName: string, callback: (...args: any[]) => void): () => void;
}

export interface AudioSharePatchbayOptions {
    /** The release asset name for the patchcord binary itself, e.g. `patchcord-linux-x64`. */
    assetName: string;
    releaseUrlBase: string;
    args?: readonly string[];
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    sinkPrefix?: string;
    sinkDescription?: string;
    virtualMic?: boolean;
    sinkBecomesDefault?: boolean;
    virtualMicName?: string;
    virtualMicDescription?: string;
}

export type StartResult =
    | { ok: true }
    | { ok: false; reason: string;[key: string]: any };

export declare class AudioSharePatchbay extends EventEmitter {
    constructor(nativeHandle: NativeHandle, options: AudioSharePatchbayOptions);

    /**
     * Ensures the patchcord asset is downloaded (consent-gated -- may
     * return `{ ok: false, reason: "not_consented", ... }`, in which
     * case the caller should drive the consent flow via native.ts's
     * `recordConsent` and call `start()` again) and spawned. Idempotent.
     */
    start(): Promise<StartResult>;

    hasPipeWire(): Promise<boolean>;
    listShareableNodes(includeDevices?: boolean): Promise<ShareableNode[]>;
    findScreencastHint(): Promise<ScreencastHint | null>;
    /**
     * Routes the given node id(s) directly into every one of Discord's
     * own `discord_capture` screenshare-audio nodes, replacing whatever
     * selection was previously routed there. Pass an empty array to stop
     * routing anything. Requires `discord-capture-shim` to be installed
     * (see nativeOrchestration.ts), or `discord_capture` nodes keep
     * auto-linking themselves to every detected app regardless.
     */
    setDiscordCaptureTargets(nodeIds: number[], filter?: RouteFilter): Promise<void>;
    dispose(): Promise<void>;

    on(eventName: "graphChanged" | "monitorDied", listener: () => void): this;
    once(eventName: "graphChanged" | "monitorDied", listener: () => void): this;
    off(eventName: "graphChanged" | "monitorDied", listener: () => void): this;
    emit(eventName: "graphChanged" | "monitorDied"): boolean;

    on(eventName: string | symbol, listener: (...args: any[]) => void): this;
    once(eventName: string | symbol, listener: (...args: any[]) => void): this;
    off(eventName: string | symbol, listener: (...args: any[]) => void): this;
    emit(eventName: string | symbol, ...args: any[]): boolean;
}
