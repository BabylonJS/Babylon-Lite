/**
 * fetch-antigravity-racer.ts — download the two CC-BY-4.0 Sketchfab models used
 * by the Antigravity Racer demo (the "RHS-X" racing ship and the
 * "Obj_Nat_Rock_01" boulder), exactly as published alongside Cédric Guillemet's
 * original Babylon.js playground (snippet WVPVWL).
 *
 * Both models are Creative Commons Attribution 4.0: free to use, share and
 * adapt — including commercially — provided the authors are credited. Each
 * glTF already carries its author / license / source in `asset.extras`; we keep
 * those files byte-identical and additionally write a CREDITS.txt next to them,
 * and credit both artists on the demo's main menu.
 *
 * We do NOT commit the model binaries to git (see .gitignore) — they are ~12 MB
 * of third-party art. This script fetches them from a PINNED commit of
 * CedricGuillemet/dump at dev/build time into `lab/public/antigravity-racer/`,
 * preserving the models' relative layout so the `scene.bin` / `textures/*`
 * URIs inside each `scene.gltf` still resolve. The demo then loads them from
 * that local path (`demoAssetUrl("./antigravity-racer/…")`) — never from a
 * mutable remote URL at runtime.
 *
 * The road artwork under `lab/public/antigravity-racer/track/` is NOT fetched:
 * its author granted us redistribution rights, so it is committed (the
 * .gitignore rules re-include exactly that folder) and this script leaves it
 * and its CREDITS.txt alone.
 *
 * Usage:  pnpm tsx scripts/fetch-antigravity-racer.ts
 * No third-party deps and no archive parsing: each file is fetched individually
 * from the pinned raw.githubusercontent.com blob.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned commit of CedricGuillemet/dump that hosts both models. */
const DUMP_SHA = "5644ca43efc962e619e861019f72c6a64d3b2246";
const RAW_BASE = `https://raw.githubusercontent.com/CedricGuillemet/dump/${DUMP_SHA}`;

/**
 * Repo-relative paths we pull, written to `lab/public/antigravity-racer/<same path>`.
 * The `textures/` sub-paths must be preserved verbatim: they are the image URIs
 * declared inside each `scene.gltf`.
 */
const WANTED_FILES: string[] = [
    // Racing ship — "RHS-X" by Hassan Bassassi (alone5), CC BY 4.0
    "rhs-x/scene.gltf",
    "rhs-x/scene.bin",
    "rhs-x/textures/material_baseColor.jpeg",
    "rhs-x/textures/material_normal.jpeg",
    "rhs-x/textures/material_metallicRoughness.png",
    "rhs-x/textures/material_emissive.jpeg",
    // Boulder — "Obj_Nat_Rock_01" by SaschaHenrichs, CC BY 4.0
    "obj_nat_rock_01/scene.gltf",
    "obj_nat_rock_01/scene.bin",
    "obj_nat_rock_01/textures/Obj_Stone_01_baseColor.jpeg",
    "obj_nat_rock_01/textures/Obj_Stone_01_normal.png",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "antigravity-racer");
const CACHE_DIR = join(ROOT, ".antigravity-racer-cache");
const SOURCE_STAMP = join(CACHE_DIR, "source-sha");
const CREDITS_DEST = join(OUT_DIR, "CREDITS.txt");

const CREDITS_TEXT = `Antigravity Racer — third-party asset attribution
==================================================

Both 3D models below are licensed under the Creative Commons Attribution 4.0
International license (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/.
They are redistributed unmodified; each glTF carries the same author / license /
source information in its "asset.extras" block.

1. Racing ship — "RHS-X"
   Author:  Hassan Bassassi (alone5), https://sketchfab.com/alone5
   Source:  https://sketchfab.com/models/6e02774161ec465fb5cf4c78f4e41adf
   License: CC BY 4.0
   Files:   rhs-x/scene.gltf, rhs-x/scene.bin, rhs-x/textures/*

2. Boulder — "Obj_Nat_Rock_01"
   Author:  SaschaHenrichs, https://sketchfab.com/SaschaHenrichs
   Source:  https://sketchfab.com/models/62d63fd7d1dd416aac1496eb19c43cc0
   License: CC BY 4.0
   Files:   obj_nat_rock_01/scene.gltf, obj_nat_rock_01/scene.bin,
            obj_nat_rock_01/textures/*

Fetched from the pinned commit ${DUMP_SHA}
of https://github.com/CedricGuillemet/dump (the same files the original
Babylon.js playground loads).

3. Road artwork — track/*.png
   Author:  Patrick Ryan
   Rights:  the author owns this artwork and granted this repository the right
            to redistribute it, so unlike the two models above it is committed
            to git rather than fetched. Extracted losslessly from the embedded
            textures of the playground's node material (snippet 01HFES#76).
   Details: see track/CREDITS.txt, which this script does not touch.

The demo's engine trails and terrain are original procedural work.
`;

export async function fetchAntigravityRacer(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    const sourceCurrent = existsSync(SOURCE_STAMP) && readFileSync(SOURCE_STAMP, "utf8").trim() === DUMP_SHA;
    const allPresent = WANTED_FILES.every((p) => existsSync(join(OUT_DIR, p)));
    if (sourceCurrent && allPresent) {
        console.log("Antigravity Racer models already present in lab/public/antigravity-racer/ — nothing to do.");
        writeFileSync(CREDITS_DEST, CREDITS_TEXT);
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
            throw new Error(`Antigravity Racer asset download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
        fetched++;
        console.log(`Fetched ${path} → ${dest} (${(bytes.length / 1024).toFixed(0)} KB)`);
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(SOURCE_STAMP, `${DUMP_SHA}\n`);
    writeFileSync(CREDITS_DEST, CREDITS_TEXT);
    console.log(`Done (${fetched} file(s) fetched). Antigravity Racer assets are gitignored; re-run this script to restore them.`);
}

// Run only when invoked directly (e.g. `pnpm fetch:antigravity-racer`), not when
// imported by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchAntigravityRacer().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
