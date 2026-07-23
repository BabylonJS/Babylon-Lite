/**
 * fetch-racer.ts — download the CC0-licensed Kenney "Starter Kit Racing" art
 * (car / motorcycle / track-tile GLB models, the shared colormap texture, the
 * smoke sprite and the engine/skid/impact audio) used by the Racer demo.
 *
 * Kenney's assets (https://kenney.nl) are released under Creative Commons Zero
 * (CC0, public-domain dedication): free to use, modify and redistribute, with
 * attribution appreciated but not required. The starter kit itself lives at
 * https://github.com/KenneyNL/Starter-Kit-Racing (code MIT, assets CC0).
 *
 * We do NOT commit the binaries to git (see .gitignore); this script fetches a
 * pinned commit at dev/build time into `lab/public/racer/`, preserving the kit's
 * relative layout so any texture references inside the GLBs still resolve.
 *
 * The demo's engine + gameplay code is an original clean-room port of the kit's
 * GDScript vehicle controller — no Godot engine code is copied or shipped.
 *
 * Usage:  pnpm tsx scripts/fetch-racer.ts
 * No third-party deps and no archive parsing: each file is fetched individually
 * from the pinned raw.githubusercontent.com blob.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned commit of KenneyNL/Starter-Kit-Racing (Godot 4.6 kit). */
const KIT_SHA = "f5241ebdf00c25bc951bf4fdb7950bb1b78b4bcc";
const RAW_BASE = `https://raw.githubusercontent.com/KenneyNL/Starter-Kit-Racing/${KIT_SHA}`;

/**
 * Repo-relative paths we pull, written to `lab/public/racer/<same path>`.
 * "Everything" the kit ships for gameplay parity: all vehicles + the motorcycle,
 * every track tile, the decorations, the shared colormap, the smoke sprite and
 * the audio — plus the LICENSE / README for CC0 attribution hygiene.
 */
const WANTED_FILES: string[] = [
    // Vehicles
    "models/vehicle-truck-yellow.glb",
    "models/vehicle-truck-green.glb",
    "models/vehicle-truck-purple.glb",
    "models/vehicle-truck-red.glb",
    "models/vehicle-motorcycle.glb",
    // Track tiles
    "models/track-straight.glb",
    "models/track-corner.glb",
    "models/track-finish.glb",
    "models/track-bump.glb",
    "models/track-tents.glb",
    // Decorations
    "models/decoration-empty.glb",
    "models/decoration-forest.glb",
    "models/decoration-tents.glb",
    // Shared texture (kept at the kit's relative path so GLB refs resolve)
    "models/Textures/colormap.png",
    // Smoke sprite (used for the drift trail)
    "sprites/smoke.png",
    // Audio
    "audio/engine.ogg",
    "audio/engine-motorcycle.ogg",
    "audio/skid.ogg",
    "audio/impact.ogg",
    // Attribution / license
    "LICENSE",
    "README.md",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "racer");
const CACHE_DIR = join(ROOT, ".racer-cache");
const SOURCE_STAMP = join(CACHE_DIR, "source-sha");

export async function fetchRacer(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const sourceCurrent = existsSync(SOURCE_STAMP) && readFileSync(SOURCE_STAMP, "utf8").trim() === KIT_SHA;
    const allPresent = WANTED_FILES.every((p) => existsSync(join(OUT_DIR, p)));
    if (sourceCurrent && allPresent) {
        console.log("Kenney Starter Kit Racing assets already present in lab/public/racer/ — nothing to do.");
        return;
    }

    let fetched = 0;
    for (const path of WANTED_FILES) {
        const dest = join(OUT_DIR, path);
        if (sourceCurrent && existsSync(dest)) {
            continue;
        }
        const url = `${RAW_BASE}/${path}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Racer asset download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
        fetched++;
        console.log(`Fetched ${path} → ${dest} (${(bytes.length / 1024).toFixed(0)} KB)`);
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(SOURCE_STAMP, `${KIT_SHA}\n`);
    console.log(`Done (${fetched} file(s) fetched). Racer assets are gitignored; re-run this script to restore them.`);
}

// Run only when invoked directly (e.g. `pnpm fetch:racer`), not when imported by
// the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchRacer().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
