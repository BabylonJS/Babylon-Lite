// Reference scene 93 — Thin Babylon.js sprite path with a pre-baked palette atlas.
//
// Mirrors lab/src/bjs/scene50.ts grid geometry but uses the hard-alpha cutout
// atlas and bakes the same 256-entry colormap remap into the atlas pixels on a
// canvas (RGB := palette[redByte], alpha preserved). Rendered with nearest
// filtering, this is bit-exact with Lite's WGSL `palette[texel.r]` lookup.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";
import { bakeRemappedAtlasDataUrl, buildColormapPalette } from "../_shared/palette-remap";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();

    const clearColor = new Color4(0.05, 0.06, 0.09, 1);

    const bakedAtlasUrl = await bakeRemappedAtlasDataUrl(getCutoutSpriteAtlasDataUrl(), buildColormapPalette());
    const texture = new Texture(bakedAtlasUrl, engine, /* noMipmap */ true, /* invertY */ false, Texture.NEAREST_SAMPLINGMODE);

    const renderer = new SpriteRenderer(engine, 256, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx;
    renderer.cellHeight = CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx;
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
            const frame = idx % 8;
            const tintIdx = idx % 3;
            const sizePx = idx % 11 === 0 ? 40 : 28;

            const sprite = new ThinSprite();
            sprite.position = new Vector3(ox + c * cellPx, canvas.height - (oy + r * cellPx), 0);
            sprite.width = sizePx;
            sprite.height = sizePx;
            sprite.cellIndex = frame;
            sprite.angle = idx % 5 === 0 ? -Math.PI / 6 : 0;
            sprite.invertU = idx % 7 === 0;
            if (tintIdx === 1) {
                sprite.color = new Color4(1, 0.7, 0.7, 1);
            } else if (tintIdx === 2) {
                sprite.color = new Color4(0.7, 1, 0.85, 1);
            } else {
                sprite.color = new Color4(1, 1, 1, 1);
            }
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
