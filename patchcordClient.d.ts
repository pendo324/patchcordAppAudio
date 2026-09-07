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
 * Best-effort correlation of an in-progress KDE/KWin window-share with a
 * likely audio-producing app. See patchcord's `ScreencastHint` Rust doc
 * comment (src/patchbay/models.rs) for the full mechanism: KWin names its
 * screencast video node `kwin-screencast-<desktopFileName>`, which is
 * visible as a plain PipeWire node independent of whatever opaque source
 * id Chromium's getDisplayMedia() picker flow hands back to the page.
 * `null` (from `findScreencastHint()`) is the normal case when no window
 * share is active or the compositor isn't KWin -- callers should fall back
 * to showing the full unfiltered node list, not treat it as an error.
 */
export interface ScreencastHint {
    desktopFileId: string;
    hint: string;
}

export interface VirtualSinkInfo {
    sinkName: string;
    monitorSource: string;
    nodeId: number;
    virtualMicName?: string | null;
    virtualMicDescription?: string | null;
}

export interface AudioSharePatchbayOptions {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    sinkPrefix?: string;
    sinkDescription?: string;
    virtualMic?: boolean;
    /**
     * Creates the virtual sink as a plain Audio/Sink (rather than
     * Audio/Sink/Virtual) and makes it the system default sink once ready,
     * so app-routed audio actually reaches Discord's own "Stream With
     * Audio" capture (which always grabs the *default* sink's monitor).
     * Mutually exclusive with virtualMic -- see PatchbayConfig's Rust doc
     * comment for why.
     */
    sinkBecomesDefault?: boolean;
    virtualMicName?: string;
    virtualMicDescription?: string;
}

export declare class AudioSharePatchbay extends EventEmitter {
    constructor(options: AudioSharePatchbayOptions);
    hasPipeWire(): Promise<boolean>;
    listShareableNodes(includeDevices?: boolean): Promise<ShareableNode[]>;
    findScreencastHint(): Promise<ScreencastHint | null>;
    ensureVirtualSink(): Promise<VirtualSinkInfo>;
    routeNodes(nodeIds: number[], filter?: RouteFilter): Promise<VirtualSinkInfo>;
    clearRoutes(): Promise<void>;
    setVirtualMicMute(mute: boolean): Promise<void>;
    setDefaultSinkToVirtual(): Promise<void>;
    restoreDefaultSink(): Promise<void>;
    dispose(): Promise<void>;

    on(eventName: 'graphChanged' | 'monitorDied', listener: () => void): this;
    once(eventName: 'graphChanged' | 'monitorDied', listener: () => void): this;
    off(eventName: 'graphChanged' | 'monitorDied', listener: () => void): this;
    emit(eventName: 'graphChanged' | 'monitorDied'): boolean;

    on(eventName: string | symbol, listener: (...args: any[]) => void): this;
    once(eventName: string | symbol, listener: (...args: any[]) => void): this;
    off(eventName: string | symbol, listener: (...args: any[]) => void): this;
    emit(eventName: string | symbol, ...args: any[]): boolean;
}

export declare function hasPipeWire(
    options: AudioSharePatchbayOptions,
): Promise<boolean>;