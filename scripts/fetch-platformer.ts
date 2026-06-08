/**
 * fetch-platformer.ts — curate the CC0 Kenney "Platformer Art Deluxe" sprite
 * assets used by the platformer demo.
 *
 * Kenney's assets (https://kenney.nl) are released under Creative Commons Zero
 * (CC0, public-domain dedication): free to use, modify and redistribute, with
 * attribution appreciated but not required.
 *
 * Platformer Art Deluxe is the larger "classic" Kenney platformer pack (930
 * files): it has richly-themed tilesets (grass / dirt / stone / snow / castle
 * with full edge + corner variety — great for an underground level), themed
 * background images, and the modern flat "alien" character sheets. We curate a
 * small XML-spritesheet subset; the demo's atlas loader parses the TexturePacker
 * XML directly.
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
 * The release ZIP is parsed with Node's built-in zlib. After extraction, one
 * NON-DESTRUCTIVE post-process runs (scripts/bleed-platformer-alpha.ts, via the
 * dev-dependency `pngjs`): it "alpha-bleeds" the linear-filtered sheets so they
 * don't render with a dark edge fringe. It only recolours pixels whose alpha is
 * already 0, so every visible pixel stays byte-identical.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bleedPlatformerAlpha } from "./bleed-platformer-alpha";

const PACK_VERSION = "deluxe";
const ZIP_URL = "https://kenney.nl/media/pages/assets/platformer-art-deluxe/cb30f83169-1677696393/kenney_platformer-art-deluxe.zip";
/** SHA-256 of kenney_platformer-art-deluxe.zip, verified after download. */
const ZIP_SHA256 = "232c5644858287181ff5b20107b1969064a2833dd4ab51a6a4c5997889d2720d";

/**
 * Curated subset to extract — `zip entry path` → `destination (relative to OUT_DIR)`.
 * We take the modern combined alien character sheet + the extra-enemies sheet (both
 * TexturePacker XML), the Base-pack tiles / items / HUD sheets, and a few themed
 * backgrounds. The Base-pack tiles sheet holds grass/dirt/stone/castle terrain AND
 * the box / brick blocks, so there is no separate "ground" sheet (the demo binds the
 * terrain and block layers to the same tiles atlas).
 */
const WANTED: ReadonlyArray<readonly [string, string]> = [
    ["Extra animations and enemies/Spritesheets/aliens.png", "players.png"],
    ["Extra animations and enemies/Spritesheets/aliens.xml", "players.xml"],
    ["Extra animations and enemies/Spritesheets/enemies.png", "enemies.png"],
    ["Extra animations and enemies/Spritesheets/enemies.xml", "enemies.xml"],
    ["Base pack/Items/items_spritesheet.png", "items.png"],
    ["Base pack/Items/items_spritesheet.xml", "items.xml"],
    ["Base pack/Tiles/tiles_spritesheet.png", "tiles.png"],
    ["Base pack/Tiles/tiles_spritesheet.xml", "tiles.xml"],
    ["Base pack/HUD/hud_spritesheet.png", "hud.png"],
    ["Base pack/HUD/hud_spritesheet.xml", "hud.xml"],
    ["Mushroom expansion/Backgrounds/bg_grasslands.png", "backgrounds/bg_grasslands.png"],
    ["Mushroom expansion/Backgrounds/bg_castle.png", "backgrounds/bg_castle.png"],
    ["Mushroom expansion/Backgrounds/bg_shroom.png", "backgrounds/bg_shroom.png"],
    ["license.txt", "License.txt"],
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
    let fromCache = false;
    if (existsSync(cachedZip)) {
        console.log(`Using cached ${cachedZip}`);
        zipBuf = readFileSync(cachedZip);
        fromCache = true;
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
        // Fail fast: a hash mismatch means the bytes are NOT the pinned, vetted pack — a
        // corrupted cache, a changed/compromised upstream, or an un-bumped version. Extracting
        // anyway would defeat the script's provenance/reproducibility guarantee, so we refuse.
        // A stale/corrupt CACHED zip is deleted so the next run re-downloads cleanly.
        if (fromCache) {
            rmSync(cachedZip, { force: true });
        }
        throw new Error(
            `Platformer pack zip SHA-256 mismatch — refusing to extract.\n` +
                `  expected ${expected}\n` +
                `  actual   ${sha}\n` +
                (fromCache
                    ? `The cached zip was corrupt or stale and has been deleted; re-run this script to re-download.\n`
                    : `The freshly downloaded zip does not match the pinned hash — verify the source before trusting it.\n`) +
                `If this is an INTENTIONAL upstream version bump, update ZIP_URL + ZIP_SHA256 together.`
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

    // Non-destructive edge dilation so linear-filtered sheets don't fringe (see module docs).
    bleedPlatformerAlpha(OUT_DIR);
    console.log("Done. The curated platformer assets are COMMITTED to the repo (CC0); no runtime fetch is needed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchPlatformer().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
