// Scene 117 — 2D Sprite Picking
// Lays out a deterministic 5×3 grid of HUD sprites (pure-2D path), picks the centre sprite
// with `pickSprite2D`, and highlights the hit by tinting it gold. The BJS oracle renders the
// same grid via ThinSprite and tints the same (deterministic) centre sprite, so the pixels
// match while these `dataset` values prove Lite's `pickSprite2D` actually resolved the hit.

import {
    addSprite2DIndex,
    createEngine,
    createSprite2DLayer,
    createSpriteRenderer,
    loadSpriteAtlas,
    pickSprite2D,
    registerSpriteRenderer,
    startEngine,
    updateSprite2DIndex,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const GRID_COLS = 5;
const GRID_ROWS = 3;
const SPRITE_PX = 72;
const SPACING_PX = 112;
// Centre cell (col 2, row 1) → index 7 with row-major insertion order.
const TARGET_COL = 2;
const TARGET_ROW = 1;
const TARGET_INDEX = TARGET_ROW * GRID_COLS + TARGET_COL;
const HIGHLIGHT_COLOR: [number, number, number, number] = [1, 0.85, 0.1, 1];

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });

    const layer = createSprite2DLayer(atlas, { capacity: GRID_COLS * GRID_ROWS, depth: "none" });

    // Grid centred on the canvas backing store; the centre cell lands exactly at screen centre.
    const originX = canvas.width / 2 - ((GRID_COLS - 1) * SPACING_PX) / 2;
    const originY = canvas.height / 2 - ((GRID_ROWS - 1) * SPACING_PX) / 2;
    for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
            const index = r * GRID_COLS + c;
            addSprite2DIndex(layer, {
                positionPx: [originX + c * SPACING_PX, originY + r * SPACING_PX],
                sizePx: [SPRITE_PX, SPRITE_PX],
                frame: 8 + (index % 15),
            });
        }
    }

    const sr = createSpriteRenderer(engine, {
        layers: [layer],
        clearValue: { r: 0.07, g: 0.08, b: 0.12, a: 1.0 },
    });
    registerSpriteRenderer(sr);

    await startEngine(engine);
    await waitFrames(2);

    // Pick the centre sprite (its positionPx is exactly screen centre in identity-view layer space).
    const hit = pickSprite2D(sr.layers, canvas.width / 2, canvas.height / 2);
    let highlightApplied = false;
    if (hit) {
        updateSprite2DIndex(hit.layer, hit.spriteIndex, { color: HIGHLIGHT_COLOR });
        highlightApplied = true;
    }

    await waitFrames(2);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickedHit = hit ? String(hit.spriteIndex) : "miss";
    canvas.dataset.expectedIndex = String(TARGET_INDEX);
    canvas.dataset.pickedU = hit ? hit.u.toPrecision(6) : "";
    canvas.dataset.pickedV = hit ? hit.v.toPrecision(6) : "";
    canvas.dataset.highlightApplied = String(highlightApplied);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
