// Babylon.js reference for Scene 117: 2D Sprite Picking.
//
// Renders the same deterministic 5×3 HUD sprite grid as the Lite scene using the thin
// `WebGPUEngine + SpriteRenderer + ThinSprite` path (no Scene), and tints the same centre
// sprite gold. Babylon has no 2D-sprite pick equivalent of `pickSprite2D`, so this oracle
// replicates the deterministic highlight — the picking itself is validated by the Lite
// scene's `dataset` state; this side only has to reproduce the pixels.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const GRID_COLS = 5;
const GRID_ROWS = 3;
const SPRITE_PX = 72;
const SPACING_PX = 112;
const TARGET_INDEX = 1 * GRID_COLS + 2; // centre cell (col 2, row 1)

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();

    const clearColor = new Color4(0.07, 0.08, 0.12, 1);

    const texture = new Texture(getSpriteAtlasDataUrl(), engine, /* noMipmap */ true, /* invertY */ false, Texture.BILINEAR_SAMPLINGMODE);

    const renderer = new SpriteRenderer(engine, GRID_COLS * GRID_ROWS, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = SPRITE_ATLAS_INFO.cellWidthPx;
    renderer.cellHeight = SPRITE_ATLAS_INFO.cellHeightPx;
    renderer.disableDepthWrite = true;

    const originX = canvas.width / 2 - ((GRID_COLS - 1) * SPACING_PX) / 2;
    const originY = canvas.height / 2 - ((GRID_ROWS - 1) * SPACING_PX) / 2;

    const sprites: ThinSprite[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
            const index = r * GRID_COLS + c;
            const sprite = new ThinSprite();
            // Lite uses pixel space with +Y down; this path projects +Y up, so flip Y here
            // (matches scene 50's reference) — UVs stay upright.
            sprite.position = new Vector3(originX + c * SPACING_PX, canvas.height - (originY + r * SPACING_PX), 0);
            sprite.width = SPRITE_PX;
            sprite.height = SPRITE_PX;
            sprite.cellIndex = 8 + (index % 15);
            sprite.color = index === TARGET_INDEX ? new Color4(1, 0.85, 0.1, 1) : new Color4(1, 1, 1, 1);
            sprite.isVisible = true;
            sprites.push(sprite);
        }
    }

    const view = Matrix.LookAtLH(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    const projection = Matrix.OrthoOffCenterLH(0, canvas.width, 0, canvas.height, 0.1, 100, engine.isNDCHalfZRange);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    const rendererInternal = renderer as unknown as { _shadersLoaded: boolean };

    let firstFrame = true;
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });

    engine.runRenderLoop(() => {
        eng._drawCalls?.fetchNewFrame();
        engine.clear(clearColor, true, true, true);
        renderer.render(sprites, 0, view, projection);
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
        if (firstFrame && texture.isReady() && rendererInternal._shadersLoaded) {
            firstFrame = false;
            resolveReady();
        }
    });
    window.addEventListener("resize", () => engine.resize());

    await readyPromise;
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickedHit = String(TARGET_INDEX);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
