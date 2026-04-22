// Scene 51 — Soft-Edged Sprite Grid (Premultiplied Alpha Path)
//
// 25×10 grid of radial-gradient sprites with anti-aliased edges. The
// real semi-transparent edge pixels mean any storage / blend mismatch
// produces a visibly bright halo, so this scene exercises the
// premultiplied codepath in earnest:
//
//   - `premultiplyOnLoad: true`  → texture is decoded with
//     `createImageBitmap({ premultiplyAlpha: "premultiply" })`, so the
//     GPU texture genuinely holds premultiplied RGBA.
//   - `premultipliedAlpha: true` → atlas is marked premultiplied.
//   - layer `blendMode: "premultiplied"` → renderer picks the
//     `srcFactor: ONE` blend pipeline.
//
// The BJS oracle (lab/src/bjs/scene51.ts) loads a pre-baked
// premultiplied data URL and sets `SpriteRenderer.blendMode =
// ALPHA_PREMULTIPLIED` to reach the same end-state. Both renderers see
// premultiplied bits and use the matching blend factors.

import { addSprite2DIndex, createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, startEngine } from "babylon-lite";
import { getSoftSpriteAtlasDataUrl, SOFT_SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-soft";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // MSAA 1 by default (sprite edges come from texture alpha, not geometry).
    // Parity tests pass `?msaa=4` to match the BJS oracle's default 4x MSAA.
    const msaaParam = new URLSearchParams(window.location.search).get("msaa");
    const msaaSamples: 1 | 4 = msaaParam === "4" ? 4 : 1;
    const engine = await createEngine(canvas, { msaaSamples });
    const atlas = await loadSpriteAtlas(engine, getSoftSpriteAtlasDataUrl(), {
        gridSize: [SOFT_SPRITE_ATLAS_INFO.cellWidthPx, SOFT_SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
        premultipliedAlpha: true,
        premultiplyOnLoad: true,
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256, blendMode: "premultiplied", depth: "none" });

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
            // 32 distinct gradient hues in the atlas; cycle through them.
            const frame = idx % 32;
            const tintIdx = idx % 3;
            const color: [number, number, number, number] = tintIdx === 0 ? [1, 1, 1, 1] : tintIdx === 1 ? [1, 0.7, 0.7, 1] : [0.7, 1, 0.85, 1];
            const rotation = idx % 5 === 0 ? Math.PI / 6 : 0;
            const flipX = idx % 7 === 0;
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
