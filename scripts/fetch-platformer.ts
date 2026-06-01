/**
 * fetch-platformer.ts — curate the CC0 Kenney "Platformer Pack Remastered"
 * (the modern successor to "Platformer Pack Redux") sprite assets used by the
 * platformer demo.
 *
 * Kenney's assets (https://kenney.nl) are released under Creative Commons Zero
 * (CC0, public-domain dedication): free to use, modify and redistribute, with
 * attribution appreciated but not required.
 *
 * Unlike the voxel/freeciv demos, the platformer's curated subset is COMMITTED to
 * the repo (it is small and CC0, so there is no licensing reason to keep it out of
 * git and no runtime network dependency). This script exists for provenance and
 * reproducibility: it pins the exact upstream zip + SHA-256 and documents precisely
 * which entries we extract. Run it once to (re)populate lab/public/platformer/, then
 * commit the output.
 *
 * We never ship Nintendo code or assets — the engine here is original and the only
 * bundled art is CC0.
 *
 * Usage:  pnpm tsx scripts/fetch-platformer.ts
 * No third-party deps: the release ZIP is parsed with Node's built-in zlib.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_VERSION = "remastered";
const ZIP_URL = "https://kenney.nl/media/pages/assets/platformer-pack-remastered/cee5812394-1774772013/kenney_platformer-pack-remastered.zip";
/** SHA-256 of kenney_platformer-pack-remastered.zip, verified after download. */
const ZIP_SHA256 = "abbe0800c68d5ceeb3b5bb411125dab7d56768232b3b4500a456b36ce5b7dada";

/**
 * Curated subset to extract — `zip entry path` → `destination (relative to OUT_DIR)`.
 * We take the per-category TexturePacker spritesheets (PNG + XML) rather than the
 * hundreds of loose PNGs or the 966 KB combined sheet, plus a couple of parallax
 * backgrounds and the CC0 license file.
 */
const WANTED: ReadonlyArray<readonly [string, string]> = [
    ["Spritesheets/spritesheet_players.png", "players.png"],
    ["Spritesheets/spritesheet_players.xml", "players.xml"],
    ["Spritesheets/spritesheet_enemies.png", "enemies.png"],
    ["Spritesheets/spritesheet_enemies.xml", "enemies.xml"],
    ["Spritesheets/spritesheet_items.png", "items.png"],
    ["Spritesheets/spritesheet_items.xml", "items.xml"],
    ["Spritesheets/spritesheet_tiles.png", "tiles.png"],
    ["Spritesheets/spritesheet_tiles.xml", "tiles.xml"],
    ["Spritesheets/spritesheet_ground.png", "ground.png"],
    ["Spritesheets/spritesheet_ground.xml", "ground.xml"],
    ["Spritesheets/spritesheet_hud.png", "hud.png"],
    ["Spritesheets/spritesheet_hud.xml", "hud.xml"],
    ["PNG/Backgrounds/colored_grass.png", "backgrounds/colored_grass.png"],
    ["PNG/Backgrounds/colored_desert.png", "backgrounds/colored_desert.png"],
    ["PNG/Backgrounds/blue_grass.png", "backgrounds/blue_grass.png"],
    ["License.txt", "License.txt"],
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "platformer");
const CACHE_DIR = join(ROOT, ".platformer-cache");

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

/** Parse the ZIP central directory (enough of the spec for a standard release zip). */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error("platformer pack zip: End Of Central Directory not found");
    }
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) {
            throw new Error("platformer pack zip: bad central directory signature");
        }
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
    if (buf.readUInt32LE(lho) !== 0x04034b50) {
        throw new Error(`platformer pack zip: bad local header for ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) {
        return Buffer.from(raw);
    }
    if (entry.method === 8) {
        return inflateRawSync(raw);
    }
    throw new Error(`platformer pack zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

export async function fetchPlatformer(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const allPresent = WANTED.every(([, dest]) => existsSync(join(OUT_DIR, dest)));
    if (allPresent) {
        console.log(`Kenney Platformer Pack (${PACK_VERSION}) already present in lab/public/platformer/ — nothing to do.`);
        return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const cachedZip = join(CACHE_DIR, `kenney_platformer-pack-${PACK_VERSION}.zip`);

    let zipBuf: Buffer;
    if (existsSync(cachedZip)) {
        console.log(`Using cached ${cachedZip}`);
        zipBuf = readFileSync(cachedZip);
    } else {
        console.log(`Downloading ${ZIP_URL} …`);
        const res = await fetch(ZIP_URL);
        if (!res.ok) {
            throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
        }
        zipBuf = Buffer.from(await res.arrayBuffer());
        writeFileSync(cachedZip, zipBuf);
        console.log(`Downloaded ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    }

    const sha = createHash("sha256").update(zipBuf).digest("hex");
    const expected = ZIP_SHA256.replace(/\s+/g, "");
    if (expected && sha !== expected) {
        console.warn(
            `WARNING: Platformer pack zip SHA-256 mismatch.\n  expected ${expected}\n  actual   ${sha}\nProceeding, but verify the source. Update ZIP_SHA256 if this is an intentional version bump.`
        );
    }

    const entries = parseCentralDirectory(zipBuf);
    for (const [zipPath, dest] of WANTED) {
        const entry = entries.find((e) => e.name === zipPath);
        if (!entry) {
            throw new Error(`platformer pack zip: ${zipPath} not found in archive`);
        }
        const bytes = extractEntry(zipBuf, entry);
        const outPath = join(OUT_DIR, dest);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, bytes);
        console.log(`Extracted ${zipPath} → ${dest} (${(bytes.length / 1024).toFixed(0)} KB)`);
    }

    console.log("Done. The curated platformer assets are COMMITTED to the repo (CC0); no runtime fetch is needed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchPlatformer().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
