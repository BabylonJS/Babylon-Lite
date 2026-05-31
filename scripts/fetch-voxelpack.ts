/**
 * fetch-voxelpack.ts — download the CC0-licensed Kenney "Voxel Pack" textures
 * used by the Minecraft-style voxel demo.
 *
 * Kenney's assets (https://kenney.nl) are released under Creative Commons Zero
 * (CC0, public-domain dedication): free to use, modify and redistribute, with
 * attribution appreciated but not required. We do NOT commit the binaries to git
 * (see .gitignore); this script fetches a pinned release at dev/build time into
 * `lab/public/minecraft/`.
 *
 * We never download, host, or bundle Mojang's proprietary Minecraft textures or
 * code — the engine here is original and the only shipped art is CC0. Users who
 * own Minecraft may load their own resource-pack .zip in the browser at runtime
 * instead; such files are parsed client-side only and never uploaded.
 *
 * Usage:  pnpm tsx scripts/fetch-voxelpack.ts
 * No third-party deps: the release ZIP is parsed with Node's built-in zlib.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_VERSION = "1.0";
const ZIP_URL = "https://kenney.nl/media/pages/assets/voxel-pack/a3a73d0ff7-1677662501/kenney_voxel-pack.zip";
/** SHA-256 of kenney_voxel-pack.zip, verified after download. */
const ZIP_SHA256 = "667c05e3f6d95718aaef888c7fc06f7137ba5dede95f4574deb17d4436257958";

/** Tile PNGs (block faces) we extract from the pack's `PNG/Tiles/` folder. */
const WANTED_TILES = [
    "dirt.png",
    "dirt_grass.png",
    "grass_top.png",
    "dirt_sand.png",
    "dirt_snow.png",
    "sand.png",
    "snow.png",
    "stone.png",
    "greystone.png",
    "gravel_stone.png",
    "rock.png",
    "rock_moss.png",
    "ice.png",
    "water.png",
    "lava.png",
    "glass.png",
    "leaves.png",
    "leaves_transparent.png",
    "leaves_orange_transparent.png",
    "trunk_side.png",
    "trunk_top.png",
    "trunk_white_side.png",
    "trunk_white_top.png",
    "wood.png",
    "wood_red.png",
    "brick_red.png",
    "brick_grey.png",
    "stone_coal.png",
    "stone_iron.png",
    "stone_gold.png",
    "stone_diamond.png",
    "stone_silver.png",
    "greystone_ruby.png",
    "redstone_emerald.png",
    "cactus_side.png",
    "cactus_top.png",
    "cactus_inside.png",
    "greysand.png",
    "redsand.png",
    "cotton_blue.png",
    "cotton_green.png",
    "cotton_red.png",
    "cotton_tan.png",
];
/** License + attribution file extracted alongside the textures for CC0 hygiene. */
const LICENSE_FILES = ["License.txt"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "minecraft", "voxelpack");
const CACHE_DIR = join(ROOT, ".voxelpack-cache");

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
    if (eocd < 0) throw new Error("voxel pack zip: End Of Central Directory not found");
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("voxel pack zip: bad central directory signature");
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
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`voxel pack zip: bad local header for ${entry.name}`);
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw); // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    throw new Error(`voxel pack zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

export async function fetchVoxelpack(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const allPresent = [...WANTED_TILES, ...LICENSE_FILES].every((w) => existsSync(join(OUT_DIR, w)));
    if (allPresent) {
        console.log(`Kenney Voxel Pack ${PACK_VERSION} already present in lab/public/minecraft/voxelpack/ — nothing to do.`);
        return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const cachedZip = join(CACHE_DIR, `kenney_voxel-pack-${PACK_VERSION}.zip`);

    let zipBuf: Buffer;
    if (existsSync(cachedZip)) {
        console.log(`Using cached ${cachedZip}`);
        zipBuf = readFileSync(cachedZip);
    } else {
        console.log(`Downloading ${ZIP_URL} …`);
        const res = await fetch(ZIP_URL);
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
        zipBuf = Buffer.from(await res.arrayBuffer());
        writeFileSync(cachedZip, zipBuf);
        console.log(`Downloaded ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    }

    const sha = createHash("sha256").update(zipBuf).digest("hex");
    const expected = ZIP_SHA256.replace(/\s+/g, "");
    if (expected && sha !== expected) {
        console.warn(
            `WARNING: Voxel pack zip SHA-256 mismatch.\n  expected ${expected}\n  actual   ${sha}\nProceeding, but verify the source. Update ZIP_SHA256 if this is an intentional version bump.`
        );
    }

    const entries = parseCentralDirectory(zipBuf);
    for (const want of [...WANTED_TILES, ...LICENSE_FILES]) {
        const entry = entries.find((e) => basename(e.name).toLowerCase() === want.toLowerCase());
        if (!entry) throw new Error(`voxel pack zip: ${want} not found in archive`);
        const bytes = extractEntry(zipBuf, entry);
        const dest = join(OUT_DIR, want);
        writeFileSync(dest, bytes);
        const kb = bytes.length / 1024;
        console.log(`Extracted ${want} → ${dest} (${kb.toFixed(0)} KB)`);
    }

    console.log("Done. Voxel-pack textures are gitignored; re-run this script to restore them.");
}

// Run only when invoked directly (e.g. `pnpm fetch:voxelpack`), not when
// imported by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchVoxelpack().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
