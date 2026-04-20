// Scene 32 — Sprites UI (Family 1: pure 2D HUD).
//
// Demonstrates a HUD-style layout entirely in `Scene2DContext`:
//   - Top bar with score "digits" (tally-mark frames) and an icon row.
//   - Bottom-left health bar built from repeated icon frames.
//   - Centre-bottom action icon.
//   - All sprites use varied alpha/color to exercise per-sprite tint blending.

import { createEngine, createScene2DContext, addToScene2D, addSprite2DIndex, createSprite2DLayer, loadSpriteAtlas, startEngine2D } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createScene2DContext(engine, { clearColor: { r: 0.05, g: 0.06, b: 0.09, a: 1 } });

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        cellWidthPx: SPRITE_ATLAS_INFO.cellWidthPx,
        cellHeightPx: SPRITE_ATLAS_INFO.cellHeightPx,
        columns: SPRITE_ATLAS_INFO.columns,
        rows: SPRITE_ATLAS_INFO.rows,
        sampling: "linear",
    });

    // Layer 1 — backdrop icon row (low alpha, larger).
    const back = createSprite2DLayer(atlas, { capacity: 32, order: 0, opacity: 0.35 });
    for (let i = 0; i < 16; i++) {
        addSprite2DIndex(back, {
            positionPx: [80 + i * 76, 360],
            sizePx: [64, 64],
            frame: 8 + i,
        });
    }
    addToScene2D(scene, back);

    // Layer 2 — top score (tally digits frames 24..31).
    const score = createSprite2DLayer(atlas, { capacity: 8, order: 10 });
    const digits = [3, 1, 4, 1, 5];
    for (let i = 0; i < digits.length; i++) {
        addSprite2DIndex(score, {
            positionPx: [60 + i * 50, 60],
            sizePx: [40, 40],
            frame: 24 + digits[i]!,
        });
    }
    addToScene2D(scene, score);

    // Layer 3 — health bar (10 segments, first 7 healthy, last 3 dimmed).
    const health = createSprite2DLayer(atlas, { capacity: 16, order: 20 });
    for (let i = 0; i < 10; i++) {
        const healthy = i < 7;
        addSprite2DIndex(health, {
            positionPx: [60 + i * 28, canvas.height - 60],
            sizePx: [24, 24],
            frame: 8, // first icon
            color: healthy ? [0.2, 1.0, 0.4, 1.0] : [0.5, 0.5, 0.5, 0.6],
        });
    }
    addToScene2D(scene, health);

    // Layer 4 — central action icon (rotated, large).
    const action = createSprite2DLayer(atlas, { capacity: 4, order: 30 });
    addSprite2DIndex(action, {
        positionPx: [canvas.width / 2, canvas.height - 100],
        sizePx: [96, 96],
        frame: 12,
        rotation: Math.PI / 12,
        color: [1, 0.95, 0.7, 1],
    });
    addToScene2D(scene, action);

    await startEngine2D(engine, scene);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
