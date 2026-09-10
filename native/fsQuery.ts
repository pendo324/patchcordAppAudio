/*
 * Equicord userplugin: patchcordAppAudio
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { statSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { dirname, join } from "path";

/** The directory containing the currently running host executable (e.g. Discord's own binary). */
export function getHostExecutableDir(): string {
    return dirname(process.execPath);
}

/**
 * The main process's own `process.arch`. Renderer code has no `process`
 * global at all (Electron doesn't expose Node globals to a
 * `nodeIntegration: false` renderer), so anything needing the host
 * architecture -- e.g. picking which release asset to download -- has
 * to ask main for it via this rather than reading `process.arch`
 * directly from plugin code that also runs in the renderer.
 */
export function getArch(): string {
    return process.arch;
}

/**
 * Generic path-join primitive, exposed because renderer code has no
 * `path` module of its own to build filesystem paths with (Equicord's
 * renderer/main-process split gives renderer code no Node builtins at
 * all) -- callers that need to combine path segments computed from
 * other native.ts results (e.g. `getHostExecutableDir()` + `"modules"`)
 * do so via this rather than manual string concatenation, which would
 * be platform-separator-fragile.
 */
export function joinPath(...segments: string[]): string {
    return join(...segments);
}

/**
 * Reads `path` and reports whether its raw bytes contain `needleUtf8`
 * (encoded as UTF-8) anywhere. Generic byte-content probe -- has no
 * knowledge of ELF, DT_NEEDED, or any specific file format; a caller
 * checking e.g. "does this shared object already depend on
 * my-shim.so" (a much weaker check than actually parsing the ELF
 * dynamic section, but sufficient for a non-authoritative status
 * display -- the authoritative check happens in discord-capture-setup
 * itself, which does properly parse it, when the install/restore
 * action actually runs) uses this the same way `grep -q` would.
 */
export async function fileContainsBytes(path: string, needleUtf8: string): Promise<boolean> {
    try {
        const buf = await readFile(path);
        return buf.includes(Buffer.from(needleUtf8, "utf8"));
    } catch {
        return false;
    }
}

/**
 * Recursively searches under `baseDir` (bounded to `maxDepth` levels)
 * for files/directories whose name matches `namePattern`, returning
 * every match found (a match on a directory does not stop recursion
 * into it -- e.g. searching for a directory-name pattern and a
 * file-name pattern in the same call both work, each independently).
 * Silently skips any subdirectory it cannot read (permissions, race
 * with deletion, etc.) rather than failing the whole search.
 */
export async function findFiles(baseDir: string, namePattern: RegExp, maxDepth: number): Promise<string[]> {
    if (maxDepth < 0) return [];

    let entries: string[];
    try {
        entries = await readdir(baseDir);
    } catch {
        return [];
    }

    const found: string[] = [];
    for (const entry of entries) {
        const full = join(baseDir, entry);
        if (namePattern.test(entry)) found.push(full);

        try {
            if (statSync(full).isDirectory()) {
                found.push(...await findFiles(full, namePattern, maxDepth - 1));
            }
        } catch {
            // unreadable entry, skip
        }
    }
    return found;
}
