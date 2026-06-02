// Scene 92 — Sprite Custom Shader (params-driven tint)
//
// The pure-2D sprite grid from scene 50, but the layer is drawn with an opt-in
// custom fragment shader that multiplies the atlas sample and per-sprite tint by
// a constant `fx.params` vec4 set once before the first frame. No `fx.time` term
// is referenced, so the rendered frame is fully deterministic.
//
// Parity oracle: BJS renders the same grid via SpriteRenderer with each sprite's
// `color` pre-multiplied by `fx.params` (the multiply commutes through the
// straight-alpha blend, so the pixels are identical).

import { createEngine, createSprite2DCustomShader, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, setSprite2DShaderParams, startEngine } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";
import { addDeterministicSpriteGrid } from "../_shared/sprite-grid";

export const SCENE92_PARAMS: [number, number, number, number] = [1.0, 0.78, 0.55, 1.0];

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });

    const customShader = createSprite2DCustomShader({
        fragment: `return textureSample(atlasTex, atlasSamp, in.uv) * in.tint * fx.params;`,
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256, depth: "none", customShader });
    setSprite2DShaderParams(layer, SCENE92_PARAMS);
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
