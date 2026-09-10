/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";

function consentStoreDir(): string {
    return join(app.getPath("userData"), "..", "Equicord", "patchcordAppAudio");
}

function consentStorePath(): string {
    return join(consentStoreDir(), "native-consent.json");
}

interface ConsentRecord {
    /** ISO timestamp of when this was granted, for the user's own reference if they inspect the file. */
    grantedAt: string;
}

interface ConsentStore {
    /** Keyed by `${assetName}:${sha256}`. */
    grants: Record<string, ConsentRecord>;
    /**
     * Set of `${assetName}:${sha256}` pairs that a real `ensureAsset`
     * download has actually observed and is waiting on consent for --
     * see `recordPendingDownload`/`recordConsent`'s doc comments for why
     * this exists: `recordConsent` refuses to grant consent for any pair
     * that was never actually seen as a pending, real download attempt,
     * so a caller cannot "pre-consent" to an arbitrary checksum it just
     * made up without this plugin's own code ever having downloaded and
     * hashed that exact file itself.
     */
    pending: Record<string, true>;
    /**
     * If true, skips prompting entirely for any future asset (still
     * requires a real `ensureAsset` download/hash to populate `pending`
     * before `recordConsent` can act on it -- this only means "assume
     * yes" instead of asking, not "trust any claimed hash"). Off by
     * default; the user opts into this explicitly from plugin settings.
     */
    autoApprove: boolean;
}

let cache: ConsentStore | null = null;

async function load(): Promise<ConsentStore> {
    if (cache) return cache;
    try {
        const raw = await readFile(consentStorePath(), "utf8");
        const parsed = JSON.parse(raw);
        cache = {
            grants: typeof parsed.grants === "object" && parsed.grants !== null ? parsed.grants : {},
            pending: typeof parsed.pending === "object" && parsed.pending !== null ? parsed.pending : {},
            autoApprove: parsed.autoApprove === true,
        };
    } catch {
        cache = { grants: {}, pending: {}, autoApprove: false };
    }
    return cache;
}

async function save(store: ConsentStore): Promise<void> {
    cache = store;
    const dir = consentStoreDir();
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    // Write-to-temp-then-rename: a crash mid-write must never corrupt an
    // already-valid consent ledger into something that fails to parse
    // (which would otherwise silently reset every prior grant to "not
    // consented" -- annoying, not dangerous, but avoidable for free).
    // A unique-per-call tmp path (not a fixed name) so two overlapping
    // save() calls -- e.g. from concurrent ensureAsset() calls -- never
    // race on the same tmp file's rename() (one call's rename() target
    // disappearing out from under a second call's own rename()).
    const tmp = `${consentStorePath()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2));
    await rename(tmp, consentStorePath());
}

function key(assetName: string, sha256: string): string {
    return `${assetName}:${sha256}`;
}

/**
 * Called by `nativeAssetStore.ensureAsset` the moment it has actually
 * downloaded and hashed a real file, before asking whether it's
 * consented -- marks that `(assetName, sha256)` pair as a real,
 * observed pending download, which `recordConsent` requires before it
 * will grant anything (see `ConsentStore.pending`'s doc comment).
 */
export async function recordPendingDownload(assetName: string, sha256: string): Promise<void> {
    const store = await load();
    store.pending[key(assetName, sha256)] = true;
    await save(store);
}

export async function hasConsented(assetName: string, sha256: string): Promise<boolean> {
    const store = await load();
    if (store.autoApprove) return true;
    return key(assetName, sha256) in store.grants;
}

/**
 * Grants consent for a specific `(assetName, sha256)` pair. Refuses
 * (returns false, grants nothing) unless that exact pair was previously
 * recorded via `recordPendingDownload` -- i.e. this plugin's own code
 * really did download and hash that file itself. This is what makes
 * consent an actual attestation about a real file this process
 * observed, not just an opaque flag a caller can set for any string it
 * likes.
 */
export async function recordConsent(assetName: string, sha256: string): Promise<boolean> {
    const store = await load();
    if (!(key(assetName, sha256) in store.pending)) return false;
    store.grants[key(assetName, sha256)] = { grantedAt: new Date().toISOString() };
    await save(store);
    return true;
}

export async function revokeConsent(assetName: string, sha256: string): Promise<void> {
    const store = await load();
    delete store.grants[key(assetName, sha256)];
    await save(store);
}

export async function getAutoApprove(): Promise<boolean> {
    return (await load()).autoApprove;
}

export async function setAutoApprove(value: boolean): Promise<void> {
    const store = await load();
    store.autoApprove = value;
    await save(store);
}
