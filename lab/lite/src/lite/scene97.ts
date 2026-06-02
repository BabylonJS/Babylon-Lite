// Scene 97 — Sprite Multiply Blend
//
// The pure-2D sprite grid from scene 50/92, but the layer is drawn with the
// opt-in `spriteBlendMultiply` blend mode (result = src * dst) over a light,
// non-black clear colour so the sprites visibly darken / tint the background.
// Uses the fully-opaque icon frames (8..23) so the multiply is well defined for
// every texel (a pure multiply ignores source alpha for RGB). Fully static /
// deterministic — no time term.
//
// Parity oracle: BJS renders the same grid via SpriteRenderer with a pre-baked
// atlas whose pixels were multiplied by the same clear colour on a canvas, drawn
// with straight-alpha blend. Because the cells are opaque, src*dst equals the
// pre-baked product, so the pixels are identical.

import { createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, spriteBlendMultiply, startEngine } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";
import { addDeterministicSpriteGrid } from "../_shared/sprite-grid";

export const SCENE97_CLEAR: { r: number; g: number; b: number; a: number } = { r: 0.82, g: 0.8, b: 0.86, a: 1.0 };

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256, depth: "none", blendMode: spriteBlendMultiply });
    addDeterministicSpriteGrid(layer, canvas, { frameForIndex: (index) => 8 + (index % 16) });

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: SCENE97_CLEAR,
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
