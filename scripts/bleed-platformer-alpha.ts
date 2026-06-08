/**
 * bleed-platformer-alpha.ts — "alpha bleed" (edge dilation) post-process for the
 * Kenney platformer sprite sheets.
 *
 * WHY: the Kenney PNGs are STRAIGHT-alpha, and every fully-transparent pixel has
 * RGB = (0, 0, 0). When a sprite is drawn with bilinear ("linear") filtering and
 * scaled up, the GPU interpolates across the sprite's anti-aliased edge between an
 * opaque colour texel and a transparent BLACK texel — pulling the edge toward
 * black and producing a faint dark outline ("fringe") around the sprite.
 *
 * THE FIX (industry-standard, what texture packers call "alpha bleed" / "dilate"):
 * give every transparent pixel the colour of its nearest opaque neighbour, so the
 * bilinear kernel interpolates colour↔colour instead of colour↔black. This is
 * NON-DESTRUCTIVE: only the RGB of pixels whose ALPHA IS ALREADY 0 changes; the
 * alpha channel and every visible (alpha > 0) pixel are byte-identical, so the
 * rendered result viewed directly is unchanged — only the filtered edge is fixed.
 *
 * The dilation starts from the original opaque boundary and spreads a fixed number
 * of pixels deep, so running it twice yields the same result (idempotent).
 *
 * Only the LINEAR-filtered, scaled-up sheets need this (players, enemies, items,
 * hud). The tiles sheet is sampled with "nearest" (no interpolation → no fringe)
 * and the backgrounds are fully opaque, so both are skipped.
 *
 * Usage:  pnpm tsx scripts/bleed-platformer-alpha.ts
 * (also run automatically as the last step of scripts/fetch-platformer.ts)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

/** Sheets drawn with linear filtering that benefit from edge dilation. */
export const BLEED_SHEETS = ["players", "enemies", "items", "hud"] as const;

/**
 * Dilate opaque colour into transparent pixels of one PNG, `passes` pixels deep.
 * Returns the number of transparent pixels recoloured. Idempotent: the dilation
 * always starts from the original opaque set (alpha > 0), so re-running reproduces
 * the same output.
 */
export function bleedAlpha(path: string, passes = 4): number {
    const png = PNG.sync.read(readFileSync(path));
    const { width: w, height: h, data } = png;
    // "known" = a pixel we can sample a colour from: originally opaque (alpha > 0)
    // at the start, plus any pixel filled in a previous pass this run.
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) known[i] = data[i * 4 + 3]! > 0 ? 1 : 0;

    let totalFilled = 0;
    for (let p = 0; p < passes; p++) {
        const fills: { i: number; r: number; g: number; b: number }[] = [];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (known[i]) continue; // already has a colour to sample
                let r = 0, g = 0, b = 0, n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        const j = ny * w + nx;
                        if (!known[j]) continue;
                        r += data[j * 4]!;
                        g += data[j * 4 + 1]!;
                        b += data[j * 4 + 2]!;
                        n++;
                    }
                }
                if (n > 0) fills.push({ i, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) });
            }
        }
        if (fills.length === 0) break;
        for (const f of fills) {
            data[f.i * 4] = f.r;
            data[f.i * 4 + 1] = f.g;
            data[f.i * 4 + 2] = f.b;
            // alpha (data[f.i*4+3]) is left at 0 — the pixel stays invisible.
            known[f.i] = 1;
        }
        totalFilled += fills.length;
    }
    if (totalFilled > 0) writeFileSync(path, PNG.sync.write(png));
    return totalFilled;
}

/** Bleed every linear-filtered platformer sheet found under `outDir`. */
export function bleedPlatformerAlpha(outDir: string, passes = 4): void {
    for (const name of BLEED_SHEETS) {
        const path = join(outDir, `${name}.png`);
        if (!existsSync(path)) continue;
        const filled = bleedAlpha(path, passes);
        console.log(`Alpha-bled ${name}.png: recoloured ${filled} transparent pixels (alpha unchanged)`);
    }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const outDir = join(process.cwd(), "lab", "public", "platformer");
    bleedPlatformerAlpha(outDir);
}
