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

import { createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, startEngine } from "babylon-lite";
import { getSoftSpriteAtlasDataUrl, SOFT_SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-soft";
import { addDeterministicSpriteGrid } from "../_shared/sprite-grid";

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
    addDeterministicSpriteGrid(layer, canvas, { frameForIndex: (index) => index % 32 });

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.07, g: 0.08, b: 0.12, a: 1.0 },
    });
    registerSpriteRenderer(sr);

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
