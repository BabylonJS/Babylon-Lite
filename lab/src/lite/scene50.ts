// Scene 50 — Sprite Grid
//
// A deterministic 25×10 grid of icon sprites with cycled tints and rotated
// thirds, rendered via the pure-2D sprite API
// (createSpriteRenderer / registerSpriteRenderer).

import { createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, startEngine } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";
import { addDeterministicSpriteGrid } from "../_shared/sprite-grid";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
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
    addDeterministicSpriteGrid(layer, canvas, { frameForIndex: (index) => 8 + (index % 16) });

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
