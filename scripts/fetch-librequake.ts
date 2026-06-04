/**
 * fetch-librequake.ts — download the BSD-licensed LibreQuake assets for the
 * Quake demo (first level, lq_e1m1).
 *
 * LibreQuake (https://github.com/lavenderdotpet/LibreQuake) is free/libre game
 * data released under a BSD 3-Clause license. We do NOT commit the binaries to
 * git (see .gitignore); this script fetches a pinned release at dev/build time
 * into `lab/public/librequake/`.
 *
 * The release ships a single `full.zip` whose `id1/pak0.pak` (a classic Quake
 * PAK archive) contains the compiled maps + palette. We only need the first
 * level's BSP and the palette, so we extract just those two lumps plus the
 * COPYING / CREDITS files for attribution.
 *
 * Usage:  pnpm tsx scripts/fetch-librequake.ts
 * No third-party deps: the release ZIP is parsed with Node's built-in zlib.
 */

import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LQ_VERSION = "v0.09-beta";
const ZIP_URL = `https://github.com/lavenderdotpet/LibreQuake/releases/download/${LQ_VERSION}/full.zip`;

/** PAK path inside the zip that holds the compiled maps + palette. */
const PAK_IN_ZIP = "full/id1/pak0.pak";
/** Files we pull out of the PAK, mapped to their output names. */
const PAK_WANTED: Record<string, string> = {
    "maps/lq_e1m1.bsp": "lq_e1m1.bsp",
    "gfx/palette.lmp": "palette.lmp",
    // Alias (.mdl) models for E1M1 enemies + the player shotgun viewmodel.
    "progs/soldier.mdl": "progs/soldier.mdl",
    "progs/dog.mdl": "progs/dog.mdl",
    "progs/v_shot.mdl": "progs/v_shot.mdl",
    "progs/v_shot2.mdl": "progs/v_shot2.mdl", // super shotgun viewmodel
    "progs/v_nail.mdl": "progs/v_nail.mdl", // nailgun viewmodel
    "progs/v_nail2.mdl": "progs/v_nail2.mdl", // super nailgun viewmodel
    "progs/v_rock.mdl": "progs/v_rock.mdl", // grenade launcher viewmodel
    "progs/grenade.mdl": "progs/grenade.mdl", // grenade projectile
    // Pickup item models — weapons / armor / artifacts are alias (.mdl) models…
    "progs/g_shot.mdl": "progs/g_shot.mdl", // super shotgun
    "progs/g_nail.mdl": "progs/g_nail.mdl", // nailgun
    "progs/g_nail2.mdl": "progs/g_nail2.mdl", // super nailgun
    "progs/g_rock.mdl": "progs/g_rock.mdl", // grenade launcher
    "progs/g_rock2.mdl": "progs/g_rock2.mdl", // rocket launcher
    "progs/g_light.mdl": "progs/g_light.mdl", // lightning gun
    "progs/armor.mdl": "progs/armor.mdl", // armor (skins 0/1/2)
    "progs/quaddama.mdl": "progs/quaddama.mdl", // quad damage
    "progs/suit.mdl": "progs/suit.mdl", // biosuit
    "progs/invulner.mdl": "progs/invulner.mdl", // pentagram
    "progs/invisibl.mdl": "progs/invisibl.mdl", // ring
    // …while ammo & health pickups are small brush (.bsp) models.
    "maps/b_shell0.bsp": "maps/b_shell0.bsp", // shells (small)
    "maps/b_shell1.bsp": "maps/b_shell1.bsp", // shells (big)
    "maps/b_nail0.bsp": "maps/b_nail0.bsp", // spikes (small)
    "maps/b_nail1.bsp": "maps/b_nail1.bsp", // spikes (big)
    "maps/b_rock0.bsp": "maps/b_rock0.bsp", // rockets (small)
    "maps/b_rock1.bsp": "maps/b_rock1.bsp", // rockets (big)
    "maps/b_batt0.bsp": "maps/b_batt0.bsp", // cells (small)
    "maps/b_batt1.bsp": "maps/b_batt1.bsp", // cells (big)
    "maps/b_bh10.bsp": "maps/b_bh10.bsp", // health (rotten, 15)
    "maps/b_bh25.bsp": "maps/b_bh25.bsp", // health (25)
    "maps/b_bh100.bsp": "maps/b_bh100.bsp", // megahealth (100)
    "maps/b_explob.bsp": "maps/b_explob.bsp", // exploding box
    // Classic HUD status-bar graphics (WAD2). Contains SBAR/IBAR backgrounds,
    // NUM_/ANUM_ digits, FACE animation, SB_* ammo/armor/powerup icons, INV_*
    // weapon icons and CONCHARS. Parsed + decoded to textures at runtime.
    "gfx.wad": "gfx.wad",
    // Sound effects (RIFF WAV) for weapon fire, pickups, player + monster
    // pain/death and doors. Decoded at runtime via the Web Audio API.
    "sound/weapons/guncock.wav": "sound/weapons/guncock.wav", // shotgun fire
    "sound/weapons/shotgn2.wav": "sound/weapons/shotgn2.wav", // super shotgun fire
    "sound/weapons/rocket1i.wav": "sound/weapons/rocket1i.wav", // nailgun / super nailgun fire
    "sound/weapons/grenade.wav": "sound/weapons/grenade.wav", // grenade launcher fire
    "sound/weapons/bounce.wav": "sound/weapons/bounce.wav", // grenade bounce
    "sound/weapons/r_exp3.wav": "sound/weapons/r_exp3.wav", // explosion
    "sound/weapons/pkup.wav": "sound/weapons/pkup.wav", // weapon pickup
    "sound/weapons/lock4.wav": "sound/weapons/lock4.wav", // ammo pickup
    "sound/items/health1.wav": "sound/items/health1.wav", // health
    "sound/items/r_item2.wav": "sound/items/r_item2.wav", // megahealth
    "sound/items/armor1.wav": "sound/items/armor1.wav", // armor
    "sound/items/damage.wav": "sound/items/damage.wav", // quad damage
    "sound/items/suit.wav": "sound/items/suit.wav", // biosuit
    "sound/items/protect.wav": "sound/items/protect.wav", // pentagram
    "sound/items/inv1.wav": "sound/items/inv1.wav", // ring of shadows
    "sound/player/pain1.wav": "sound/player/pain1.wav",
    "sound/player/pain2.wav": "sound/player/pain2.wav",
    "sound/player/pain3.wav": "sound/player/pain3.wav",
    "sound/player/pain4.wav": "sound/player/pain4.wav",
    "sound/player/pain5.wav": "sound/player/pain5.wav",
    "sound/player/pain6.wav": "sound/player/pain6.wav",
    "sound/player/death1.wav": "sound/player/death1.wav",
    "sound/player/death2.wav": "sound/player/death2.wav",
    "sound/player/death3.wav": "sound/player/death3.wav",
    "sound/player/death4.wav": "sound/player/death4.wav",
    "sound/player/death5.wav": "sound/player/death5.wav",
    "sound/soldier/sight1.wav": "sound/soldier/sight1.wav",
    "sound/soldier/pain1.wav": "sound/soldier/pain1.wav",
    "sound/soldier/pain2.wav": "sound/soldier/pain2.wav",
    "sound/soldier/death1.wav": "sound/soldier/death1.wav",
    "sound/soldier/sattck1.wav": "sound/soldier/sattck1.wav", // soldier shoot
    "sound/dog/dsight.wav": "sound/dog/dsight.wav",
    "sound/dog/dpain1.wav": "sound/dog/dpain1.wav",
    "sound/dog/ddeath.wav": "sound/dog/ddeath.wav",
    "sound/dog/dattack1.wav": "sound/dog/dattack1.wav",
    "sound/doors/doormv1.wav": "sound/doors/doormv1.wav", // door moving
    "sound/doors/drclos4.wav": "sound/doors/drclos4.wav", // door stop
    "sound/doors/baseuse.wav": "sound/doors/baseuse.wav", // button press
};
/** License / attribution docs pulled straight from the zip (BSD-3 compliance). */
const ZIP_LICENSE_FILES: Record<string, string> = {
    "full/id1/docs/COPYING": "COPYING.txt",
    "full/id1/docs/CREDITS": "CREDITS.txt",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "librequake");
const CACHE_DIR = join(ROOT, ".librequake-cache");

interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    localHeaderOffset: number;
}

/** Parse the ZIP central directory (zip64-aware enough for a standard release zip). */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("librequake zip: End Of Central Directory not found");
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("librequake zip: bad central directory signature");
        const method = buf.readUInt16LE(off + 10);
        const compressedSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localHeaderOffset = buf.readUInt32LE(off + 42);
        const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
        entries.push({ name, method, compressedSize, localHeaderOffset });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Extract a single entry's bytes from the zip buffer. */
function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
    const lho = entry.localHeaderOffset;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`librequake zip: bad local header for ${entry.name}`);
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw); // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    throw new Error(`librequake zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

/** Read a classic Quake PAK directory and return the named lumps. */
function extractFromPak(pak: Buffer, wanted: Record<string, string>): Map<string, Buffer> {
    if (pak.toString("ascii", 0, 4) !== "PACK") throw new Error("librequake pak: bad magic (expected PACK)");
    const dirOfs = pak.readInt32LE(4);
    const dirLen = pak.readInt32LE(8);
    const count = dirLen / 64;
    const out = new Map<string, Buffer>();
    const targets = new Set(Object.keys(wanted).map((k) => k.toLowerCase()));
    for (let i = 0; i < count; i++) {
        const o = dirOfs + i * 64;
        const name = pak.toString("ascii", o, o + 56).replace(/\0.*$/, "");
        if (!targets.has(name.toLowerCase())) continue;
        const filePos = pak.readInt32LE(o + 56);
        const fileLen = pak.readInt32LE(o + 60);
        out.set(name.toLowerCase(), Buffer.from(pak.subarray(filePos, filePos + fileLen)));
    }
    return out;
}

export async function fetchLibrequake(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const allPresent = [...Object.values(PAK_WANTED), ...Object.values(ZIP_LICENSE_FILES)].every((w) => existsSync(join(OUT_DIR, w)));
    if (allPresent) {
        console.log(`LibreQuake ${LQ_VERSION} already present in lab/public/librequake/ — nothing to do.`);
        return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const cachedZip = join(CACHE_DIR, `librequake-${LQ_VERSION}.zip`);

    let zipBuf: Buffer;
    if (existsSync(cachedZip)) {
        console.log(`Using cached ${cachedZip}`);
        zipBuf = readFileSync(cachedZip);
    } else {
        console.log(`Downloading ${ZIP_URL} … (~115 MB)`);
        const res = await fetch(ZIP_URL);
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
        zipBuf = Buffer.from(await res.arrayBuffer());
        writeFileSync(cachedZip, zipBuf);
        console.log(`Downloaded ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    }

    const entries = parseCentralDirectory(zipBuf);

    // License/attribution docs straight from the zip.
    for (const [zipName, outName] of Object.entries(ZIP_LICENSE_FILES)) {
        const entry = entries.find((e) => e.name === zipName);
        if (!entry) {
            console.warn(`WARNING: ${zipName} not found in archive — skipping license file ${outName}.`);
            continue;
        }
        writeFileSync(join(OUT_DIR, outName), extractZipEntry(zipBuf, entry));
        console.log(`Extracted ${outName}`);
    }

    // Maps + palette from the PAK inside the zip.
    const pakEntry = entries.find((e) => e.name === PAK_IN_ZIP);
    if (!pakEntry) throw new Error(`librequake zip: ${PAK_IN_ZIP} not found in archive`);
    console.log(`Extracting ${PAK_IN_ZIP} from zip …`);
    const pak = extractZipEntry(zipBuf, pakEntry);
    const lumps = extractFromPak(pak, PAK_WANTED);
    for (const [pakName, outName] of Object.entries(PAK_WANTED)) {
        const bytes = lumps.get(pakName.toLowerCase());
        if (!bytes) throw new Error(`librequake pak: ${pakName} not found`);
        const dest = join(OUT_DIR, outName);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
        const mb = bytes.length / 1048576;
        console.log(`Extracted ${outName} → ${dest} (${mb >= 0.1 ? mb.toFixed(1) + " MB" : (bytes.length / 1024).toFixed(0) + " KB"})`);
    }

    console.log("Done. LibreQuake assets are gitignored; re-run this script to restore them.");
}

// Run only when invoked directly (e.g. `pnpm fetch:librequake`), not when
// imported by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchLibrequake().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
