/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";
import { app } from "electron";
import { existsSync } from "fs";
import { chmod, mkdir, readFile,writeFile } from "fs/promises";
import { join } from "path";

import * as consentGate from "./consentGate";

export function assetStoreDir(): string {
    return join(app.getPath("userData"), "..", "Equicord", "patchcordAppAudio", "assets");
}

function assetPath(assetName: string): string {
    return join(assetStoreDir(), assetName);
}

export interface AssetRecord {
    assetName: string;
    sha256: string;
}

export type EnsureAssetResult =
    | { ok: true; asset: AssetRecord }
    | { ok: false; reason: "not_consented"; assetName: string; sha256: string }
    | { ok: false; reason: "download_failed"; assetName: string; message: string }
    | { ok: false; reason: "checksum_mismatch"; assetName: string; expected: string | null; actual: string };

async function fetchAndHash(assetName: string, releaseUrlBase: string): Promise<
    | { ok: true; buf: Buffer; sha256: string }
    | { ok: false; reason: "download_failed"; message: string }
    | { ok: false; reason: "checksum_mismatch"; expected: string | null; actual: string }
> {
    const url = `${releaseUrlBase}/${assetName}`;
    const checksumUrl = `${url}.sha256`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch (e) {
        return { ok: false, reason: "download_failed", message: `network error: ${(e as Error).message}` };
    }
    if (!res.ok) {
        return { ok: false, reason: "download_failed", message: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());

    let checksumRes: Response;
    try {
        checksumRes = await fetch(checksumUrl);
    } catch (e) {
        return { ok: false, reason: "download_failed", message: `checksum network error: ${(e as Error).message}` };
    }
    if (!checksumRes.ok) {
        return { ok: false, reason: "download_failed", message: `checksum HTTP ${checksumRes.status}` };
    }
    const checksumText = await checksumRes.text();
    const expectedHex = checksumText.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    const actualHex = createHash("sha256").update(buf).digest("hex");

    if (!expectedHex || expectedHex.length !== 64 || expectedHex !== actualHex) {
        return { ok: false, reason: "checksum_mismatch", expected: expectedHex, actual: actualHex };
    }

    return { ok: true, buf, sha256: actualHex };
}

/**
 * Ensures `assetName` is present, checksum-verified, and consented-to
 * on disk, returning an `AssetRecord` (name + verified checksum) if so.
 *
 * If the exact file (by content, not just name) is already present
 * locally with a matching, already-consented checksum, this is a cheap
 * no-op re-verification. Otherwise: downloads, hashes, records the
 * `(assetName, sha256)` pair as a real pending download via
 * `consentGate.recordPendingDownload`, and checks
 * `consentGate.hasConsented`. If not yet consented, the downloaded
 * bytes are discarded (never written to `assetStoreDir()`) and this
 * returns `{ ok: false, reason: "not_consented", assetName, sha256 }`
 * -- the caller (renderer, via `native.ts`) is expected to show a
 * consent UI describing what this asset is and, if approved, call
 * `native.ts`'s consent-grant handler and retry.
 */
export async function ensureAsset(assetName: string, releaseUrlBase: string): Promise<EnsureAssetResult> {
    const dir = assetStoreDir();
    const path = assetPath(assetName);

    if (existsSync(path)) {
        const existingBuf = await readFile(path);
        const existingHash = createHash("sha256").update(existingBuf).digest("hex");
        if (await consentGate.hasConsented(assetName, existingHash)) {
            return { ok: true, asset: { assetName, sha256: existingHash } };
        }
        // Present on disk but not (or no longer) consented -- fall
        // through to re-fetch/re-verify rather than trusting a stale
        // local file blindly; this also naturally handles the case of a
        // local file left over from before a consent revocation.
    }

    const fetched = await fetchAndHash(assetName, releaseUrlBase);
    if (!fetched.ok) {
        if (fetched.reason === "download_failed") {
            return { ok: false, reason: "download_failed", assetName, message: fetched.message };
        }
        return { ok: false, reason: "checksum_mismatch", assetName, expected: fetched.expected, actual: fetched.actual };
    }

    await consentGate.recordPendingDownload(assetName, fetched.sha256);
    if (!(await consentGate.hasConsented(assetName, fetched.sha256))) {
        return { ok: false, reason: "not_consented", assetName, sha256: fetched.sha256 };
    }

    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(path, fetched.buf);
    await chmod(path, 0o755);

    return { ok: true, asset: { assetName, sha256: fetched.sha256 } };
}

/**
 * Re-derives the on-disk path and re-verifies the checksum for an
 * already-obtained `AssetRecord`, for use only by `nativeProcess.ts`
 * immediately before execution -- see that module's own doc comment for
 * why this re-check (rather than trusting the record as given) is the
 * actual enforcement point that makes consent structurally binding, not
 * just conventionally respected.
 */
export async function reverifyAsset(record: AssetRecord): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const path = assetPath(record.assetName);
    if (!existsSync(path)) return { ok: false, reason: "asset file no longer present on disk" };

    const buf = await readFile(path);
    const actualHash = createHash("sha256").update(buf).digest("hex");
    if (actualHash !== record.sha256) {
        return { ok: false, reason: "on-disk file no longer matches the record's checksum" };
    }
    if (!(await consentGate.hasConsented(record.assetName, actualHash))) {
        return { ok: false, reason: "consent for this asset has been revoked" };
    }

    return { ok: true, path };
}
