/**
 * fetch-littlest-tokyo.ts — restore Glen Fox's "Littlest Tokyo" animated glTF
 * diorama used by the glTF animation showcase demo, and (re)write its CREDITS.txt.
 *
 * "Littlest Tokyo" by Glen Fox is licensed under Creative Commons Attribution
 * (CC-BY 4.0): free to use, share and adapt — including commercially — provided
 * the author is credited. We therefore credit Glen Fox both on the demo card and
 * inside the demo page, and write a CREDITS.txt alongside the asset for license
 * compliance.
 *
 * Unlike most demo assets, the model binary IS committed to this repository (the
 * full-fidelity, uncompressed ~10 MB export has no stable public download URL —
 * three.js only ships a Draco-compressed variant, and the artist's original is
 * behind a Sketchfab login). This script therefore does NOT download anything: it
 * verifies the committed binary's integrity and refreshes the attribution file.
 *
 * The model carries looping node-transform + skeletal animation (cars, train,
 * smoke). Babylon Lite loads and animates it without conversion.
 *
 * Usage:  pnpm tsx scripts/fetch-littlest-tokyo.ts
 * No third-party deps: plain filesystem + Node's built-in crypto.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Original source of the uncompressed export (artist's upload; login-gated). */
const GLB_SOURCE = "https://sketchfab.com/3d-models/littlest-tokyo-94b24a60dc1b48248de50bf087c0f042";
/** SHA-256 of the committed LittlestTokyo.glb, verified on run. */
const GLB_SHA256 = "3504289bfb183f0cfef0f1606c9c7764a0fe642f8aba67c0eed46a6f5563b77c";
/** Expected size in bytes (informational). */
const GLB_SIZE = 10423788;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lab", "public", "littlest-tokyo");
const GLB_DEST = join(OUT_DIR, "LittlestTokyo.glb");
const CREDITS_DEST = join(OUT_DIR, "CREDITS.txt");

const CREDITS_TEXT = `"Littlest Tokyo" by Glen Fox — CC Attribution (CC-BY 4.0)

Author:   Glen Fox  (https://artstation.com/glenatron)
Artwork:  https://artstation.com/artwork/1AGwX
License:  Creative Commons Attribution 4.0 International (CC-BY 4.0)
          https://creativecommons.org/licenses/by/4.0/
Source:   ${GLB_SOURCE}

This model is bundled as a glTF animation showcase for Babylon Lite. The CC-BY
license permits use, sharing and adaptation provided the author is credited;
Glen Fox is credited on the demo card and inside the demo page. The full-fidelity
uncompressed binary is committed to this repository.
`;

export async function fetchLittlestTokyo(): Promise<void> {
    mkdirSync(OUT_DIR, { recursive: true });

    if (!existsSync(GLB_DEST)) {
        throw new Error(
            `Littlest Tokyo model missing at ${GLB_DEST}.\n` +
                `This asset is committed to the repository — restore it with \`git checkout -- ${GLB_DEST}\`.\n` +
                `Original source (login required): ${GLB_SOURCE}`
        );
    }

    const glbBuf = readFileSync(GLB_DEST);

    if (glbBuf.length !== GLB_SIZE) {
        console.warn(`WARNING: Littlest Tokyo GLB size mismatch.\n  expected ${GLB_SIZE} bytes\n  actual   ${glbBuf.length} bytes`);
    }

    const sha = createHash("sha256").update(glbBuf).digest("hex");
    const expected = GLB_SHA256.replace(/\s+/g, "");
    if (expected && sha !== expected) {
        console.warn(`WARNING: Littlest Tokyo GLB SHA-256 mismatch.\n  expected ${expected}\n  actual   ${sha}\nUpdate GLB_SHA256 if this is an intentional asset change.`);
    } else {
        console.log(`SHA-256 verified: ${sha}`);
    }

    writeFileSync(CREDITS_DEST, CREDITS_TEXT);
    console.log(`Wrote attribution → ${CREDITS_DEST}`);
}

// Run only when invoked directly (e.g. `pnpm fetch:littlest-tokyo`), not when
// imported by the demo-asset registry (scripts/demo-fetchers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    fetchLittlestTokyo().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
