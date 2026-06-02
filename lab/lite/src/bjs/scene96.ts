// Reference scene 96 — BJS oracle for sprite uvOffset parallax.
//
// Babylon.js SpriteRenderer cannot offset UVs per sprite, so the per-band
// `uvOffset` the Lite scene applies in the shader is baked into a tiny atlas:
// one 64×64 cell per distinct offset, each cell being the base tile rolled
// (texel-shifted, wrapping) by that offset. Each grid sprite then selects the
// cell for its band via `cellIndex`. With nearest sampling and 1-texel-per-pixel
// sprites this reproduces Lite's `sample(base, uv + uvOffset)` exactly.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getRolledTileAtlasDataUrl, SCENE96_COLS, SCENE96_ROWS, scene96BandForRow, SCROLL_TILE_SIZE } from "../_shared/scroll-tile-image";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();

    const clearColor = new Color4(0.05, 0.06, 0.09, 1);

    const texture = new Texture(getRolledTileAtlasDataUrl(), engine, /* noMipmap */ true, /* invertY */ false, Texture.NEAREST_SAMPLINGMODE);

    const renderer = new SpriteRenderer(engine, SCENE96_COLS * SCENE96_ROWS, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = SCROLL_TILE_SIZE;
    renderer.cellHeight = SCROLL_TILE_SIZE;
    renderer.disableDepthWrite = true;

    const gridWidthPx = SCENE96_COLS * SCROLL_TILE_SIZE;
    const gridHeightPx = SCENE96_ROWS * SCROLL_TILE_SIZE;
    const ox = (canvas.width - gridWidthPx) / 2 + SCROLL_TILE_SIZE / 2;
    const oy = (canvas.height - gridHeightPx) / 2 + SCROLL_TILE_SIZE / 2;

    const sprites: ThinSprite[] = [];
    for (let row = 0; row < SCENE96_ROWS; row++) {
        const cellIndex = scene96BandForRow(row);
        for (let col = 0; col < SCENE96_COLS; col++) {
            const sprite = new ThinSprite();
            sprite.position = new Vector3(ox + col * SCROLL_TILE_SIZE, canvas.height - (oy + row * SCROLL_TILE_SIZE), 0);
            sprite.width = SCROLL_TILE_SIZE;
            sprite.height = SCROLL_TILE_SIZE;
            sprite.cellIndex = cellIndex;
            sprite.color = new Color4(1, 1, 1, 1);
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
