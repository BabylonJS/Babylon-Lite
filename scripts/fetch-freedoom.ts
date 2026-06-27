/**
 * fetch-freedoom.ts — download the BSD-licensed Freedoom IWADs for the DOOM demo.
 *
 * Freedoom (https://freedoom.github.io/) is free/libre game data released under a
 * BSD 3-Clause license. We do NOT commit the binaries to git (see .gitignore);
 * this script fetches a pinned release at dev/build time into `lab/public/doom/`.
 *
 * We never download, host, or bundle id Software's commercial WADs — users may
 * supply their own legally-owned copy at runtime instead.
 *
 * Usage:  pnpm tsx scripts/fetch-freedoom.ts
 * No third-party deps: the release ZIP is parsed with Node's built-in zlib.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FREEDOOM_VERSION = "0.13.0";
const ZIP_URL = `https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip`;
/** SHA-256 of freedoom-0.13.0.zip, verified against the release CHECKSUM file. */
const ZIP_SHA256 = "3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59";

const WANTED = ["freedoom1.wad", "freedoom2.wad"];
/** License + attribution files extracted alongside the WADs for BSD compliance. */
const LICENSE_FILES = ["COPYING.txt", "CREDITS.txt"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "doom");
const CACHE_DIR = join(ROOT, ".freedoom-cache");

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

/** Parse the ZIP central directory (enough of the spec for a standard release zip). */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
    // Locate End Of Central Directory record (sig 0x06054b50), scanning back from EOF.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("freedoom zip: End Of Central Directory not found");
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("freedoom zip: bad central directory signature");
        const method = buf.readUInt16LE(off + 10);
        const compressedSize = buf.readUInt32LE(off + 20);
        const uncompressedSize = buf.readUInt32LE(off + 24);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localHeaderOffset = buf.readUInt32LE(off + 42);
        const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
        entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Extract a single entry's bytes from the zip buffer. */
function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
    const lho = entry.localHeaderOffset;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`freedoom zip: bad local header for ${entry.name}`);
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw); // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    throw new Error(`freedoom zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

export async function fetchFreedoom(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const allPresent = [...WANTED, ...LICENSE_FILES].every((w) => existsSync(join(OUT_DIR, w)));
    if (allPresent) {
        console.log(`Freedoom ${FREEDOOM_VERSION} already present in lab/public/doom/ — nothing to do.`);
        return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const cachedZip = join(CACHE_DIR, `freedoom-${FREEDOOM_VERSION}.zip`);

    let zipBuf: Buffer;
    if (existsSync(cachedZip)) {
        console.log(`Using cached ${cachedZip}`);
        zipBuf = readFileSync(cachedZip);
    } else {
        console.log(`Downloading ${ZIP_URL} …`);
        // Bypass TLS verification for corporate proxy/firewall environments
        const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        let res: Response;
        try {
            res = await fetch(ZIP_URL);
        } finally {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
        }
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
        zipBuf = Buffer.from(await res.arrayBuffer());
        writeFileSync(cachedZip, zipBuf);
        console.log(`Downloaded ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    }

    const sha = createHash("sha256").update(zipBuf).digest("hex");
    const expected = ZIP_SHA256.replace(/\s+/g, "");
    if (expected && sha !== expected) {
        console.warn(
            `WARNING: Freedoom zip SHA-256 mismatch.\n  expected ${expected}\n  actual   ${sha}\nProceeding, but verify the source. Update ZIP_SHA256 if this is an intentional version bump.`
        );
    }

    const entries = parseCentralDirectory(zipBuf);
    for (const want of [...WANTED, ...LICENSE_FILES]) {
        const entry = entries.find((e) => e.name.toLowerCase().endsWith(want.toLowerCase()));
        if (!entry) throw new Error(`freedoom zip: ${want} not found in archive`);
        const bytes = extractEntry(zipBuf, entry);
        const dest = join(OUT_DIR, want);
        writeFileSync(dest, bytes);
        const mb = bytes.length / 1048576;
        console.log(`Extracted ${want} → ${dest} (${mb >= 0.1 ? mb.toFixed(1) + " MB" : (bytes.length / 1024).toFixed(0) + " KB"})`);
    }

    console.log("Done. Freedoom IWADs are gitignored; re-run this script to restore them.");
}

// Run only when invoked directly (e.g. `pnpm fetch:freedoom`), not when imported
// by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchFreedoom().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
