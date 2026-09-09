/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginPreloadContext } from "../../pluginPreloads";

export const enum DiscordNativePatchEvents {
    ScreenSharePickerResult = "equicord:discordVoice:screenSharePickerResult",
    ScreenSharePickerAck = "equicord:discordVoice:screenSharePickerAck",
    DesktopSourceEnded = "equicord:discordVoice:desktopSourceEnded"
}

/**
 * How long to hold Discord's real "update" callback (the one that
 * actually starts the stream) waiting for the renderer-side app-audio
 * picker to resolve, before giving up and letting the share proceed
 * unmodified anyway. This only needs to guard against a genuinely stuck
 * renderer (unhandled exception, plugin disabled mid-flow, etc.) --
 * closing the modal is always an explicit user action (Start Sharing /
 * Skip / Escape), never something that happens on its own, so there's no
 * reason for this to be anywhere near "how long a user takes to click a
 * dropdown option". A short bound here actively breaks the picker: with
 * the Advanced audio filters panel and Entire System's exclude-list
 * added, browsing those before deciding can easily take longer than a
 * few seconds, and once this timeout fires, the *real* ack the user
 * eventually sends (by clicking Start Sharing) becomes a silent no-op --
 * pendingPickerAck is already null by then -- so the stream is left
 * running with Discord's normal audio despite the user's actual
 * selection, with no error shown anywhere. Generous enough that no
 * realistic amount of time spent in the modal ever trips it.
 */
const PICKER_ACK_TIMEOUT_MS = 10 * 60_000;

/**
 * Any string carrying this substring identifies an audio device as one of
 * patchcordAppAudio's own virtual mics (see that plugin's native.ts --
 * virtualMicName is always prefixed "equicord-app-audio-mic", surfaced to
 * the OS/PipeWire with a description built from "Equicord-App-Audio" per
 * PatchcordAppAudio's initPatchcord() call). Checked case-insensitively
 * against every string property of a device description object, since the
 * native addon's exact field layout (id/name/label/guid/etc.) isn't
 * documented and enumerating it defensively is more robust than guessing
 * one specific field name.
 */
const OWN_VIRTUAL_DEVICE_MARKER = "equicord-app-audio";

function looksLikeOwnVirtualDevice(device: any): boolean {
    if (!device || typeof device !== "object") return false;
    for (const value of Object.values(device)) {
        if (typeof value === "string" && value.toLowerCase().includes(OWN_VIRTUAL_DEVICE_MARKER)) {
            return true;
        }
    }
    return false;
}

const patchedModuleNames = new Set<string>();

function patchDiscordVoiceModule(voiceModule: any) {
    patchScreenSharePickerCallbacks(voiceModule);
    patchDeviceChangeCallback(voiceModule);
    patchConnectionFactories(voiceModule);
}

/**
 * Tracks the ack promise for a picker "update" event currently pending, so
 * a renderer-side ack (see PatchcordAppAudio's index.tsx) can resolve it
 * and let the real update callback proceed with starting the stream. Only
 * one ever needs to be pending at a time: setNativeScreenSharePickerCallbacks
 * is a top-level per-app registration, not per-connection.
 */
let pendingPickerAck: (() => void) | null = null;

function waitForPickerAck(): Promise<void> {
    return new Promise(resolve => {
        pendingPickerAck = resolve;
        setTimeout(() => {
            if (pendingPickerAck === resolve) {
                console.warn("[PatchcordAppAudio:preload] Timed out waiting for renderer-side app-audio picker ack; proceeding with screenshare unmodified.");
                pendingPickerAck = null;
                resolve();
            }
        }, PICKER_ACK_TIMEOUT_MS);
    });
}

window.addEventListener(DiscordNativePatchEvents.ScreenSharePickerAck, () => {
    pendingPickerAck?.();
    pendingPickerAck = null;
});

function patchScreenSharePickerCallbacks(voiceModule: any) {
    if (typeof voiceModule?.setNativeScreenSharePickerCallbacks !== "function") {
        console.warn("[PatchcordAppAudio:preload] discord_voice.setNativeScreenSharePickerCallbacks not found; native screenshare picker hook unavailable.");
        return;
    }

    const original = voiceModule.setNativeScreenSharePickerCallbacks;

    // The native C++ signature takes three callbacks (confirmed via the
    // addon's own exported symbols: NativeDesktopVideoSourcePickerUpdateCallback,
    // NativeDesktopVideoSourcePickerCancelCallback,
    // NativeDesktopVideoSourcePickerErrorCallback), not one. An earlier
    // version of this patch wrapped only the first ("update") callback and
    // assumed its first bool argument meant "success", which turned out
    // to be wrong (confirmed live: it fired with `false` on a real,
    // successful share) -- wrap and log all three so the real semantics
    // can be determined from a live run instead of guessed again.
    voiceModule.setNativeScreenSharePickerCallbacks = function (
        this: any,
        onUpdate: (...args: any[]) => void,
        onCancel: (...args: any[]) => void,
        onError: (...args: any[]) => void,
        ...rest: any[]
    ) {
        const dispatch = (kind: string, args: any[]) => {
            try {
                window.dispatchEvent(new CustomEvent(DiscordNativePatchEvents.ScreenSharePickerResult, {
                    detail: { kind, args }
                }));
            } catch (e) {
                console.error("[PatchcordAppAudio:preload] Failed to dispatch screenSharePickerResult event", e);
            }
        };

        // "update" is the one that actually starts the real stream --
        // hold it until the renderer's app-audio picker modal has
        // resolved (or times out), so Discord doesn't start streaming
        // system/default audio for a moment before our picker's choice
        // takes effect. "cancel"/"error" have nothing worth waiting for.
        const wrappedOnUpdate = async function (...args: any[]) {
            dispatch("update", args);
            await waitForPickerAck();
            return onUpdate(...args);
        };
        const wrappedOnCancel = function (...args: any[]) {
            dispatch("cancel", args);
            return onCancel(...args);
        };
        const wrappedOnError = function (...args: any[]) {
            dispatch("error", args);
            return onError(...args);
        };

        return original.call(this, wrappedOnUpdate, wrappedOnCancel, wrappedOnError, ...rest);
    };
}

/**
 * Filters patchcordAppAudio's own virtual mic out of the audio-device list
 * Discord's `setDeviceChangeCallback` reports, so Discord's own "New Audio
 * Device Detected, do you want to switch to it?" prompt (an unrelated
 * built-in feature that fires for any new audio *input* device appearing
 * system-wide -- confirmed live: it treats our virtual mic exactly like a
 * freshly plugged-in USB headset) never has a reason to fire for it in the
 * first place. This is a lower-level, more reliable fix than the
 * originally-tried DOM MutationObserver approach (which never actually
 * caught the toast in testing -- likely a timing/selector mismatch against
 * Discord's real toast implementation) since it prevents the underlying
 * signal Discord's prompt logic reacts to, rather than trying to react to
 * the UI after the fact.
 *
 * Native signature is actually 3 args: (audioInputDevices, audioOutputDevices,
 * videoInputDevices) -- confirmed live against Discord's own
 * MediaEngine.handleDeviceChange, which destructures
 * arguments[0]/[1]/[2] as audio-input/audio-output/video-input
 * respectively. An earlier version of this wrapper assumed the addon's
 * documented 2-arg C++ signature (audio devices, video devices) and only
 * declared/forwarded 2 named parameters, which silently dropped the real
 * video-input array (the 3rd argument) entirely -- discovered live via
 * CDP: MediaEngineStore.getVideoDevices() returned only a disabled
 * synthetic "default" entry and the native MediaEngine's
 * videoInputDeviceId was stuck at the "disabled" sentinel, even though
 * the native discord_voice addon's own getVideoInputDevices() correctly
 * enumerated the real camera the entire time. Forwarding all 3 arguments
 * (audio outputs untouched, since only audio *inputs* need virtual-mic
 * filtering) fixes camera detection without changing the audio-prompt
 * suppression behavior this wrapper exists for.
 */
function patchDeviceChangeCallback(voiceModule: any) {
    if (typeof voiceModule?.setDeviceChangeCallback !== "function") {
        console.warn("[PatchcordAppAudio:preload] discord_voice.setDeviceChangeCallback not found; cannot suppress own-virtual-mic device prompts.");
        return;
    }

    const original = voiceModule.setDeviceChangeCallback;

    voiceModule.setDeviceChangeCallback = function (
        this: any,
        onDeviceChange: (audioInputDevices: any[], audioOutputDevices: any[], videoInputDevices: any[]) => void
    ) {
        const wrapped = function (audioInputDevices: any[], audioOutputDevices: any[], videoInputDevices: any[]) {
            const filteredAudioInputDevices = Array.isArray(audioInputDevices)
                ? audioInputDevices.filter(d => !looksLikeOwnVirtualDevice(d))
                : audioInputDevices;
            return onDeviceChange(filteredAudioInputDevices, audioOutputDevices, videoInputDevices);
        };

        return original.call(this, wrapped);
    };
}

function patchNativeModule(name: string, mod: any) {
    if (patchedModuleNames.has(name)) return;
    patchedModuleNames.add(name);

    if (name === "discord_voice") {
        patchDiscordVoiceModule(mod);
    }
}

/**
 * Wraps setOnDesktopSourceEnded on every VoiceConnection instance Discord
 * creates, so patchcordAppAudio's virtual sink/mic teardown runs on the
 * real "this desktop source actually ended" native signal instead of
 * (as it did previously) piggy-backing on the *next* screenshare-picker
 * "update" event as a proxy for "the previous one ended" -- which fires
 * at the wrong time relative to the actual stream lifecycle and was
 * observed live to cause the shared app's own audio output to pause
 * (most media players react to their output sink disappearing, or to an
 * abrupt PipeWire route/xrun disruption, by pausing playback).
 *
 * setOnDesktopSourceEnded itself can't be patched on a shared prototype
 * (confirmed live: VoiceConnection.prototype has no own properties
 * besides "constructor" -- native N-API classes bind methods
 * per-instance in their C++ constructor), so instead we wrap the factory
 * functions that hand out connection instances
 * (createVoiceConnectionWithOptions and its alias
 * createOwnStreamConnectionWithOptions -- a *copied function reference*
 * assigned once at discord_voice's own module load time per its index.js,
 * so both must be wrapped independently or the alias stays unpatched) and
 * wrap each returned instance's setOnDesktopSourceEnded individually.
 * Doing this here in preload (rather than in the renderer, where an
 * earlier attempt at the identical technique silently patched a
 * structured-clone nobody else ever saw) means Discord's own webpack code
 * -- which actually creates and uses these connections -- sees the
 * wrapped version.
 */
function patchConnectionFactories(voiceModule: any) {
    const factoryNames = ["createVoiceConnectionWithOptions", "createOwnStreamConnectionWithOptions"];

    for (const name of factoryNames) {
        const original = voiceModule[name];
        if (typeof original !== "function") {
            console.warn(`[PatchcordAppAudio:preload] discord_voice.${name} not found; cannot hook desktop-source-ended.`);
            continue;
        }

        voiceModule[name] = function (this: any, ...args: any[]) {
            const connection = original.apply(this, args);
            wrapConnectionEndedHook(connection);
            return connection;
        };
    }
}

function wrapConnectionEndedHook(connection: any) {
    if (!connection || typeof connection.setOnDesktopSourceEnded !== "function") return;
    if (connection.__equicordEndedHookWrapped) return;
    connection.__equicordEndedHookWrapped = true;

    const original = connection.setOnDesktopSourceEnded.bind(connection);

    connection.setOnDesktopSourceEnded = function (callback: (...args: any[]) => void) {
        const wrapped = function (...args: any[]) {
            try {
                window.dispatchEvent(new CustomEvent(DiscordNativePatchEvents.DesktopSourceEnded, { detail: { args } }));
            } catch (e) {
                console.error("[PatchcordAppAudio:preload] Failed to dispatch desktopSourceEnded event", e);
            }
            return callback(...args);
        };
        return original(wrapped);
    };
}

function patchRequireModule(nativeModules: any) {
    const original = nativeModules.requireModule;
    if (typeof original !== "function") {
        console.warn("[PatchcordAppAudio:preload] nativeModules.requireModule not found; cannot install native-module patches.");
        return;
    }

    nativeModules.requireModule = function (this: any, name: string) {
        const mod = original.call(this, name);
        try {
            patchNativeModule(name, mod);
        } catch (e) {
            console.error(`[PatchcordAppAudio:preload] Failed to patch native module "${name}"`, e);
        }
        return mod;
    };
}

/**
 * Entry point run by Equicord core's generic per-plugin preload
 * mechanism (see src/pluginPreloads.ts) -- registers a hook for
 * `contextBridge.exposeInMainWorld("DiscordNative", ...)` that patches
 * `api.nativeModules.requireModule` on the real, pre-clone object before
 * it's exposed. See this file's own module doc comment for the full
 * background on why this has to happen here, in preload.
 */
export function preload(ctx: PluginPreloadContext) {
    ctx.onExposeInMainWorld("DiscordNative", api => {
        if (!api?.nativeModules) return;
        try {
            patchRequireModule(api.nativeModules);
        } catch (e) {
            console.error("[PatchcordAppAudio:preload] Failed to install requireModule patch", e);
        }
    });
}
