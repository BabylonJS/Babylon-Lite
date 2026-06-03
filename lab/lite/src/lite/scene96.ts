// Scene 96 — Sprite uvOffset Parallax
//
// Demonstrates the opt-in per-sprite `uvOffset` (uvScroll) feature: a grid of
// full-texture sprites all sampling one tileable atlas tile, where each
// horizontal band carries a different fixed `uvOffset`. The offset scrolls the
// sampled UV in the vertex stage (repeat wrap), so each band shows the same tile
// shifted by a different amount — the building block for parallax / infinite
// scroll backgrounds.
//
// Deterministic: offsets are fixed (no `time` term), so the rendered frame is stable.
//
// Parity oracle: BJS cannot offset UVs per sprite, so it bakes the identical
// effect into a small atlas (one cell per offset = the base tile rolled by that
// offset) and draws the same grid via SpriteRenderer. With nearest sampling and
// 1-texel-per-pixel sprites the two are pixel-identical.

import { addSprite2DIndex, createEngine, createSprite2DLayer, createSpriteRenderer, loadSpriteAtlas, registerSpriteRenderer, startEngine } from "babylon-lite";
import { getScrollTileDataUrl, SCENE96_BAND_OFFSETS, SCENE96_COLS, SCENE96_ROWS, scene96BandForRow, SCROLL_TILE_SIZE } from "../_shared/scroll-tile-image";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);

    // Single tileable tile loaded as a 1-cell atlas. Repeat wrap + nearest sampling
    // make the uvOffset scroll exact (no filtering seams across the wrap boundary).
    const atlas = await loadSpriteAtlas(engine, getScrollTileDataUrl(), {
        gridSize: [SCROLL_TILE_SIZE, SCROLL_TILE_SIZE],
        sampling: "nearest",
        textureOptions: { addressModeU: "repeat", addressModeV: "repeat" },
    });

    const layer = createSprite2DLayer(atlas, { capacity: SCENE96_COLS * SCENE96_ROWS, depth: "none", uvScroll: true });

    const gridWidthPx = SCENE96_COLS * SCROLL_TILE_SIZE;
    const gridHeightPx = SCENE96_ROWS * SCROLL_TILE_SIZE;
    const originX = (canvas.width - gridWidthPx) / 2 + SCROLL_TILE_SIZE / 2;
    const originY = (canvas.height - gridHeightPx) / 2 + SCROLL_TILE_SIZE / 2;

    for (let row = 0; row < SCENE96_ROWS; row++) {
        const offset = SCENE96_BAND_OFFSETS[scene96BandForRow(row)]!;
        for (let col = 0; col < SCENE96_COLS; col++) {
            addSprite2DIndex(layer, {
                positionPx: [originX + col * SCROLL_TILE_SIZE, originY + row * SCROLL_TILE_SIZE],
                sizePx: [SCROLL_TILE_SIZE, SCROLL_TILE_SIZE],
                frame: 0,
                uvOffset: [offset[0], offset[1]],
            });
        }
    }

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1.0 },
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
