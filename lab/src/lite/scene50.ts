// Scene 50 — Sprite Grid
//
// A deterministic 25×10 grid of icon sprites with cycled tints and rotated
// thirds, rendered via the pure-2D sprite API
// (createSpriteRenderer / registerSpriteRenderer).

import { addSprite2DIndex, createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, startEngine } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // MSAA 1 by default (sprite edges come from texture alpha, not geometry).
    // Parity tests pass `?msaa=4` to match the BJS oracle's default 4x MSAA.
    const msaaParam = new URLSearchParams(window.location.search).get("msaa");
    const msaaSamples: 1 | 4 = msaaParam === "4" ? 4 : 1;
    const engine = await createEngine(canvas, { msaaSamples });
    // Default sprite atlas configuration: straight-alpha bits (PNG-on-disk
    // convention) rendered with the `"alpha"` blend pipeline. This matches
    // BJS's default `SpriteRenderer.blendMode = ALPHA_COMBINE` codepath, so
    // scene 50 is the BJS-vs-Lite parity oracle for the straight-alpha path.
    // The premultiplied path is exercised in scene 51.
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256, blendMode: "alpha", depth: "none" });

    // 25 columns × 10 rows of 40-pixel-spaced icons centred in a 1280×720 canvas.
    const cols = 25;
    const rows = 10;
    const cellPx = 40;
    const gridW = cols * cellPx;
    const gridH = rows * cellPx;
    const ox = (canvas.width - gridW) / 2 + cellPx / 2;
    const oy = (canvas.height - gridH) / 2 + cellPx / 2;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            // Cycle through icon frames (8..23 — 16 distinct icons).
            const frame = 8 + (idx % 16);
            // Tint cycles through three colours to add per-sprite tint coverage.
            const tintIdx = idx % 3;
            const color: [number, number, number, number] = tintIdx === 0 ? [1, 1, 1, 1] : tintIdx === 1 ? [1, 0.7, 0.7, 1] : [0.7, 1, 0.85, 1];
            // Every 5th sprite rotated for rotation coverage.
            const rotation = idx % 5 === 0 ? Math.PI / 6 : 0;
            // Every 7th sprite flipped horizontally (flipX coverage, ported from old scene50).
            const flipX = idx % 7 === 0;
            // Every 11th sprite drawn larger (per-sprite size variation).
            const sizePx: [number, number] = idx % 11 === 0 ? [40, 40] : [28, 28];
            addSprite2DIndex(layer, {
                positionPx: [ox + c * cellPx, oy + r * cellPx],
                sizePx,
                frame,
                color,
                rotation,
                flipX,
            });
        }
    }

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.07, g: 0.08, b: 0.12, a: 1.0 },
    });
    registerSpriteRenderer(engine, sr);

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
