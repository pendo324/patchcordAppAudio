/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A minimal EventEmitter, not "node:events" -- this file is imported
// from renderer-side code (nativeOrchestration.ts), and the renderer
// bundle target has no Node builtins available (confirmed live: esbuild
// fails to resolve "node:events" when building dist/desktop/renderer.js
// -- unlike the old version of this file, which only ever ran in the
// main process via native.ts and could rely on real Node builtins).
class EventEmitter {
    #listeners = new Map();

    on(eventName, listener) {
        let set = this.#listeners.get(eventName);
        if (!set) this.#listeners.set(eventName, set = new Set());
        set.add(listener);
        return this;
    }

    off(eventName, listener) {
        this.#listeners.get(eventName)?.delete(listener);
        return this;
    }

    once(eventName, listener) {
        const wrapper = (...args) => {
            this.off(eventName, wrapper);
            listener(...args);
        };
        return this.on(eventName, wrapper);
    }

    emit(eventName, ...args) {
        const set = this.#listeners.get(eventName);
        if (!set || set.size === 0) return false;
        for (const listener of [...set]) listener(...args);
        return true;
    }
}

export class AudioSharePatchbay extends EventEmitter {
    #nativeHandle;
    #assetName;
    #releaseUrlBase;
    #args;
    #handleId = null;
    #closed = false;
    #closing = false;
    #nextId = 1;
    #pending = new Map();
    #requestTimeoutMs;
    #shutdownTimeoutMs;
    #unsubscribeLine;
    #unsubscribeExit;
    #startPromise = null;

    /**
     * `options.assetName`/`options.releaseUrlBase` identify the
     * patchcord binary to `ensureAsset` (consent-gated download) rather
     * than a literal command path -- see native/nativeAssetStore.ts.
     * `options.args` are extra CLI args (sink-prefix etc, same shape the
     * old constructor took).
     */
    constructor(nativeHandle, options) {
        super();
        this.#nativeHandle = nativeHandle;
        this.#assetName = options.assetName;
        this.#releaseUrlBase = options.releaseUrlBase;
        this.#requestTimeoutMs = sanitizeTimeout(options.requestTimeoutMs, 15_000);
        this.#shutdownTimeoutMs = sanitizeTimeout(options.shutdownTimeoutMs, 2_000);

        const args = [...(options.args ?? [])];
        if (typeof options.sinkPrefix === "string") args.push("--sink-prefix", options.sinkPrefix);
        if (typeof options.sinkDescription === "string") args.push("--sink-description", options.sinkDescription);
        if (options.virtualMic) args.push("--virtual-mic");
        if (options.sinkBecomesDefault) args.push("--sink-becomes-default");
        if (typeof options.virtualMicName === "string") args.push("--virtual-mic-name", options.virtualMicName);
        if (typeof options.virtualMicDescription === "string") args.push("--virtual-mic-description", options.virtualMicDescription);
        this.#args = args;
    }

    /**
     * Ensures the patchcord asset is downloaded/consented and spawned.
     * Idempotent -- safe to call multiple times, only actually spawns
     * once. Returns a discriminated result rather than throwing on
     * "not consented yet", so callers (this plugin's own
     * nativeOrchestration.ts) can distinguish "please show a consent
     * prompt" from a genuine failure.
     */
    async start() {
        if (this.#startPromise) return this.#startPromise;
        this.#startPromise = this.#doStart();
        return this.#startPromise;
    }

    async #doStart() {
        const assetResult = await this.#nativeHandle.invoke("ensureAsset", this.#assetName, this.#releaseUrlBase);
        if (!assetResult.ok) {
            this.#closed = true;
            return assetResult;
        }

        const spawnResult = await this.#nativeHandle.invoke("spawnPersistent", assetResult.asset, this.#args);
        if (!spawnResult.ok) {
            this.#closed = true;
            return spawnResult;
        }

        this.#handleId = spawnResult.handleId;
        this.#unsubscribeLine = this.#nativeHandle.on("line", (handleId, line) => {
            if (handleId === this.#handleId) this.#handleLine(line);
        });
        this.#unsubscribeExit = this.#nativeHandle.on("exit", (handleId, code, signal) => {
            if (handleId === this.#handleId) {
                this.#failAll(new Error(`patchcord exited (${signal ?? code ?? "unknown"})`));
            }
        });

        return { ok: true };
    }

    #handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }

        if (typeof message.event === "string") {
            this.emit(message.event, message.data);
            return;
        }

        if (!Number.isSafeInteger(message.id) || message.id < 0) return;

        const { id } = message;
        const pending = this.#pending.get(id);
        if (!pending) return;

        this.#pending.delete(id);
        clearTimeout(pending.timer);

        const errorMessage = normalizeRemoteError(message.error);
        if (errorMessage !== null) {
            pending.reject(new Error(errorMessage));
            return;
        }
        pending.resolve(message.result);
    }

    #failAll(error) {
        this.#closed = true;
        this.#closing = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
    }

    #sendRequest(method, payload = {}, allowWhenClosing = false) {
        if (this.#closed) return Promise.reject(new Error("patchcord is not running"));
        if (this.#closing && !allowWhenClosing) return Promise.reject(new Error("patchcord is shutting down"));
        if (this.#handleId === null) return Promise.reject(new Error("patchcord has not started"));

        const id = this.#nextId++;
        const line = JSON.stringify({ id, method, ...payload });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.#pending.get(id);
                if (!pending) return;
                this.#pending.delete(id);
                const error = new Error(`patchcord request timed out after ${this.#requestTimeoutMs}ms (${method})`);
                pending.reject(error);
                this.#abortProcess(error);
            }, this.#requestTimeoutMs);
            timer.unref?.();

            this.#pending.set(id, { resolve, reject, timer });

            this.#nativeHandle.invoke("writeProcessLine", this.#handleId, line).then(wrote => {
                if (wrote) return;
                const pending = this.#pending.get(id);
                if (!pending) return;
                this.#pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(new Error("patchcord stdin is not writable"));
            }).catch(err => {
                const pending = this.#pending.get(id);
                if (!pending) return;
                this.#pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(normalizeError(err));
            });
        });
    }

    #abortProcess(error) {
        this.#failAll(error);
        if (this.#handleId !== null) {
            this.#nativeHandle.invoke("disposeProcess", this.#handleId, 0).catch(() => {});
        }
    }

    #request(method, payload = {}) {
        return this.#sendRequest(method, payload, false);
    }

    async hasPipeWire() {
        return this.#request("hasPipeWire");
    }

    async listShareableNodes(includeDevices = false) {
        return this.#request("listShareableNodes", { includeDevices });
    }

    async findScreencastHint() {
        return this.#request("findScreencastHint");
    }

    /**
     * Routes the given node id(s) directly into every one of Discord's
     * own `discord_capture` screenshare-audio nodes, replacing whatever
     * selection was previously routed there. Pass an empty array to
     * stop routing anything. Requires `discord-capture-shim` to be
     * installed (see nativeOrchestration.ts's own install flow), or
     * `discord_capture` nodes keep auto-linking themselves to every
     * detected app regardless of this call.
     */
    async setDiscordCaptureTargets(nodeIds, filter = {}) {
        await this.#request("setDiscordCaptureTargets", {
            nodeIds,
            onlySpeakers: filter.onlySpeakers ?? false,
            onlyDefaultSpeakers: filter.onlyDefaultSpeakers ?? false,
            ignoreDevices: filter.ignoreDevices ?? false,
            ignoreVirtual: filter.ignoreVirtual ?? false,
            ignoreInputMedia: filter.ignoreInputMedia ?? false,
        });
    }

    async dispose() {
        if (this.#closed) return;
        if (this.#closing) return;
        this.#closing = true;

        const shutdownTimer = setTimeout(() => {
            this.#abortProcess(new Error(`patchcord did not shut down within ${this.#shutdownTimeoutMs}ms`));
        }, this.#shutdownTimeoutMs);
        shutdownTimer.unref?.();

        try {
            await this.#sendRequest("dispose", {}, true);
        } catch {
            // best-effort; disposeProcess below terminates it regardless
        } finally {
            clearTimeout(shutdownTimer);
            if (this.#handleId !== null) {
                await this.#nativeHandle.invoke("disposeProcess", this.#handleId, this.#shutdownTimeoutMs).catch(() => {});
            }
            this.#unsubscribeLine?.();
            this.#unsubscribeExit?.();
            this.#closed = true;
        }
    }
}

function sanitizeTimeout(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
}

function normalizeError(value) {
    return value instanceof Error ? value : new Error(String(value));
}

function normalizeRemoteError(value) {
    if (value == null) return null;
    return typeof value === "string" ? value : String(value);
}
