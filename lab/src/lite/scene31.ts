// Scene 31 — Sprites 2D Grid (Family 1: pure 2D scene).
//
// Renders a deterministic 25×10 = 250-sprite grid of icon frames using a
// `Scene2DContext`. Demonstrates: pure-2D rendering with no depth buffer,
// orthographic pixel coordinates, per-sprite color tint, frame variety,
// and rotation.

import { createEngine, createScene2DContext, addToScene2D, addSprite2DIndex, createSprite2DLayer, loadSpriteAtlas, startEngine2D } from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const scene = createScene2DContext(engine, { clearColor: { r: 0.07, g: 0.08, b: 0.12, a: 1 } });

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        cellWidthPx: SPRITE_ATLAS_INFO.cellWidthPx,
        cellHeightPx: SPRITE_ATLAS_INFO.cellHeightPx,
        columns: SPRITE_ATLAS_INFO.columns,
        rows: SPRITE_ATLAS_INFO.rows,
        sampling: "linear",
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256 });

    // 25 columns × 10 rows of 36-pixel-spaced icons centred in a 1280×720 canvas.
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
            // Tint cycles through three primaries to add per-sprite color test coverage.
            const tintIdx = idx % 3;
            const color: [number, number, number, number] = tintIdx === 0 ? [1, 1, 1, 1] : tintIdx === 1 ? [1, 0.7, 0.7, 1] : [0.7, 1, 0.85, 1];
            // Every 5th sprite rotated for rotation coverage.
            const rotation = idx % 5 === 0 ? Math.PI / 6 : 0;
            addSprite2DIndex(layer, {
                positionPx: [ox + c * cellPx, oy + r * cellPx],
                sizePx: [28, 28],
                frame,
                color,
                rotation,
            });
        }
    }

    addToScene2D(scene, layer);

    await startEngine2D(engine, scene);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
