// Reference scene 92 — Thin Babylon.js sprite path with params-multiplied colours.
//
// Mirrors lab/src/bjs/scene50.ts exactly (same grid geometry, projection, and
// per-sprite tints) but pre-multiplies every sprite's `color` by the same
// `fx.params` vec4 the Lite custom shader applies. The multiply commutes through
// the straight-alpha blend, so the rendered pixels are identical to Lite's
// `textureSample * tint * fx.params` fragment.

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

const PARAMS: readonly [number, number, number, number] = [1.0, 0.78, 0.55, 1.0];

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();

    const clearColor = new Color4(0.07, 0.08, 0.12, 1);

    const texture = new Texture(getSpriteAtlasDataUrl(), engine, /* noMipmap */ true, /* invertY */ false, Texture.BILINEAR_SAMPLINGMODE);

    const renderer = new SpriteRenderer(engine, 256, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = SPRITE_ATLAS_INFO.cellWidthPx;
    renderer.cellHeight = SPRITE_ATLAS_INFO.cellHeightPx;
    renderer.disableDepthWrite = true;

    const cols = 25;
    const rows = 10;
    const cellPx = 40;
    const gridW = cols * cellPx;
    const gridH = rows * cellPx;
    const ox = (canvas.width - gridW) / 2 + cellPx / 2;
    const oy = (canvas.height - gridH) / 2 + cellPx / 2;

    const sprites: ThinSprite[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const frame = 8 + (idx % 16);
            const tintIdx = idx % 3;
            const sizePx = idx % 11 === 0 ? 40 : 28;

            const sprite = new ThinSprite();
            sprite.position = new Vector3(ox + c * cellPx, canvas.height - (oy + r * cellPx), 0);
            sprite.width = sizePx;
            sprite.height = sizePx;
            sprite.cellIndex = frame;
            sprite.angle = idx % 5 === 0 ? -Math.PI / 6 : 0;
            sprite.invertU = idx % 7 === 0;
            let tint: [number, number, number, number];
            if (tintIdx === 1) {
                tint = [1, 0.7, 0.7, 1];
            } else if (tintIdx === 2) {
                tint = [0.7, 1, 0.85, 1];
            } else {
                tint = [1, 1, 1, 1];
            }
            sprite.color = new Color4(tint[0] * PARAMS[0], tint[1] * PARAMS[1], tint[2] * PARAMS[2], tint[3] * PARAMS[3]);
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
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
