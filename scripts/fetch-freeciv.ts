/**
 * fetch-freeciv.ts — download the GPL-licensed Freeciv "amplio2" isometric
 * tileset used by the Civilization-style 2D demo.
 *
 * Freeciv (https://www.freeciv.org/) is free/libre software released under the
 * GNU GPL v2+. Its bundled tilesets ship as ordinary RGBA PNG sprite sheets,
 * each paired with a plain-text `.spec` file that maps named tiles to grid
 * cells — no proprietary container format, no original-game requirement. We do
 * NOT commit the binaries to git (see .gitignore); this script fetches a pinned
 * release tag at dev/build time into `lab/public/freeciv/`.
 *
 * Unlike the BSD/CC0 assets used elsewhere in this repo, Freeciv is GPL (a
 * copyleft license). We fetch-at-build-time and never commit or redistribute
 * the art from this repository, mirroring how Freedoom/LibreQuake are handled.
 * The COPYING file is fetched alongside the art for license compliance.
 *
 * The assets are pulled as individual raw files pinned to an immutable release
 * tag — only the ~2 MB tileset is downloaded, never the full source tree.
 *
 * Usage:  pnpm tsx scripts/fetch-freeciv.ts
 * No third-party deps: plain HTTPS fetch + Node's built-in crypto.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Immutable Freeciv release tag to pin against (latest stable 3.1 series). */
const FREECIV_TAG = "R3_1_5";
const TILESET = "amplio2";
const BASE_RAW = `https://raw.githubusercontent.com/freeciv/freeciv/${FREECIV_TAG}`;

/**
 * SHA-256 over all fetched files (sorted by relative path, `relPath\0bytes`).
 * Filled after the first successful run; until then a mismatch only warns.
 */
const BUNDLE_SHA256 = "307f0024da798d50b79345ad18f7ca183588ee7217ff037948d6ec886cbbc2c1";

/**
 * Files inside `data/amplio2/` — paired PNG sprite sheets + `.spec` grid maps
 * for terrain, water, cities, units and overlays. This is the full visual set
 * for the tileset (build files like Makefile.am / .gitignore are excluded).
 */
const TILESET_FILES = [
    "activities.png",
    "activities.spec",
    "animals.png",
    "animals.spec",
    "bases.png",
    "bases.spec",
    "cities.png",
    "cities.spec",
    "explosions.png",
    "explosions.spec",
    "extra_units.png",
    "extra_units.spec",
    "fog.png",
    "fog.spec",
    "grid.png",
    "grid.spec",
    "hills.png",
    "hills.spec",
    "maglev.png",
    "maglev.spec",
    "mountains.png",
    "mountains.spec",
    "nuke.png",
    "nuke.spec",
    "ocean.png",
    "ocean.spec",
    "select-alpha.png",
    "select.spec",
    "terrain1.png",
    "terrain1.spec",
    "terrain2.png",
    "terrain2.spec",
    "tiles.png",
    "tiles.spec",
    "units.png",
    "units.spec",
    "upkeep.png",
    "upkeep.spec",
    "veterancy.png",
    "veterancy.spec",
    "water.png",
    "water.spec",
];

interface RemoteFile {
    /** Path under the Freeciv repo to download. */
    src: string;
    /** Destination path relative to OUT_DIR. */
    dest: string;
}

/** The top-level tilespec (defines tile dimensions + references the .spec files) and the license. */
const EXTRA_FILES: RemoteFile[] = [
    { src: `data/${TILESET}.tilespec`, dest: `${TILESET}.tilespec` },
    { src: "COPYING", dest: "COPYING" },
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "freeciv");
const CACHE_DIR = join(ROOT, ".freeciv-cache");

/**
 * Decorative background: Gerardus Mercator's 1569 world map, used as a subdued
 * "old atlas" backdrop behind the iso map. Published 1569 (author d. 1594), so
 * it is in the public domain worldwide. Fetched from Wikimedia Commons at the
 * pinned original resolution (1158×737, ~0.8 MB) — never committed to git.
 */
const MERCATOR_URL = "https://upload.wikimedia.org/wikipedia/commons/b/b2/Mercator_1569.png";
const MERCATOR_DEST = join(OUT_DIR, "mercator-1569.png");
const MERCATOR_LICENSE = join(OUT_DIR, "mercator-1569.LICENSE.txt");
const MERCATOR_LICENSE_TEXT = `Gerardus Mercator — World Map (Nova et Aucta Orbis Terrae Descriptio), 1569.

Public domain. Published 1569; author Gerardus Mercator died 1594, so the work
is in the public domain in its country of origin and in the United States.

Source: https://commons.wikimedia.org/wiki/File:Mercator_1569.png
File:   ${MERCATOR_URL}

Fetched at build time as a decorative backdrop for the Freeciv demo; not
committed to this repository.
`;

/** Build the full download list: tileset folder files + the extra top-level files. */
function buildFileList(): RemoteFile[] {
    const tileset = TILESET_FILES.map((name) => ({
        src: `data/${TILESET}/${name}`,
        dest: `${TILESET}/${name}`,
    }));
    return [...tileset, ...EXTRA_FILES];
}

/** Fetch one file, using the on-disk cache when present. */
async function fetchFile(file: RemoteFile): Promise<Buffer> {
    const cachePath = join(CACHE_DIR, file.dest);
    if (existsSync(cachePath)) {
        return readFileSync(cachePath);
    }
    const url = `${BASE_RAW}/${file.src}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Download failed for ${file.src}: HTTP ${res.status} ${res.statusText}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, bytes);
    return bytes;
}

export async function fetchFreeciv(): Promise<void> {
    const files = buildFileList();

    const allPresent = files.every((f) => existsSync(join(OUT_DIR, f.dest)));
    if (allPresent) {
        console.log(`Freeciv ${TILESET} tileset (${FREECIV_TAG}) already present in lab/public/freeciv/ — nothing to do.`);
        await fetchMercator();
        return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`Fetching Freeciv ${TILESET} tileset (${FREECIV_TAG}) — ${files.length} files …`);

    // Download all files, collecting bytes for the integrity hash.
    const downloaded: { dest: string; bytes: Buffer }[] = [];
    let totalBytes = 0;
    for (const file of files) {
        const bytes = await fetchFile(file);
        downloaded.push({ dest: file.dest, bytes });
        totalBytes += bytes.length;
        const dest = join(OUT_DIR, file.dest);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
    }

    // Aggregate SHA-256 over (relPath\0bytes), sorted by path for determinism.
    const hash = createHash("sha256");
    for (const { dest, bytes } of [...downloaded].sort((a, b) => a.dest.localeCompare(b.dest))) {
        hash.update(dest);
        hash.update("\0");
        hash.update(bytes);
    }
    const sha = hash.digest("hex");
    const expected = BUNDLE_SHA256.replace(/\s+/g, "");
    if (expected && sha !== expected) {
        console.warn(
            `WARNING: Freeciv bundle SHA-256 mismatch.\n  expected ${expected}\n  actual   ${sha}\nProceeding, but verify the source. Update BUNDLE_SHA256 if this is an intentional version bump.`
        );
    } else if (!expected) {
        console.log(`Bundle SHA-256 (set BUNDLE_SHA256 to pin): ${sha}`);
    }

    console.log(`Done. Extracted ${files.length} files (${(totalBytes / 1048576).toFixed(1)} MB) into lab/public/freeciv/.`);
    console.log("Freeciv assets are gitignored; re-run this script to restore them.");
    await fetchMercator();
}

/** Fetch the public-domain Mercator 1569 backdrop (idempotent). */
async function fetchMercator(): Promise<void> {
    if (existsSync(MERCATOR_DEST) && existsSync(MERCATOR_LICENSE)) return;
    console.log("Fetching Mercator 1569 backdrop (public domain) from Wikimedia Commons …");
    const res = await fetch(MERCATOR_URL);
    if (!res.ok) {
        throw new Error(`Download failed for Mercator backdrop: HTTP ${res.status} ${res.statusText}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(MERCATOR_DEST, bytes);
    writeFileSync(MERCATOR_LICENSE, MERCATOR_LICENSE_TEXT);
    console.log(`Done. Mercator backdrop (${(bytes.length / 1048576).toFixed(1)} MB) → lab/public/freeciv/mercator-1569.png`);
}

// Run only when invoked directly (e.g. `pnpm fetch:freeciv`), not when imported
// by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchFreeciv().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
