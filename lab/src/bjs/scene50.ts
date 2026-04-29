// Reference scene 50 — Thin Babylon.js sprite path (no Scene, no SpriteManager).
//
// Renders the same 25×10 sprite grid as the Lite scene using only
// `WebGPUEngine + SpriteRenderer + ThinSprite + Texture`, with `scene: null`.
// We supply our own orthographic view/projection so we avoid pulling in
// `Scene`, cameras, transform nodes, rendering-group manager, etc.
//
// This gives an apples-to-apples BJS bundle-size comparison against Lite's
// pure-2D sprite scene.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SpriteRenderer } from "@babylonjs/core/Sprites/spriteRenderer";
import { ThinSprite } from "@babylonjs/core/Sprites/thinSprite";

// Prototype augmentations needed when running without a Scene: SpriteRenderer
// calls `engine.setAlphaMode(...)`, which is attached to `ThinEngine.prototype`
// by this side-effect module. `Scene` normally pulls it in transitively; we
// do not, so it must be imported explicitly.
import "@babylonjs/core/Engines/Extensions/engine.alpha";

// Force the WGSL sprite shaders into the main bundle (they would otherwise be
// dynamically imported by SpriteRenderer). Both paths produce identical
// runtime bytes, but static imports make the bundle-size comparison
// deterministic across environments.
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
    await engine.initAsync();

    const clearColor = new Color4(0.07, 0.08, 0.12, 1);

    // Sprite atlas — same data URL as the Lite scene so the source pixels are
    // byte-identical. Mirror Lite's `loadSpriteAtlas` options: no mipmaps,
    // invertY = false, linear sampling.
    const texture = new Texture(getSpriteAtlasDataUrl(), engine, /* noMipmap */ true, /* invertY */ false, Texture.BILINEAR_SAMPLINGMODE);

    // epsilon = 0: BJS defaults to 0.01, which insets each corner by 1% of
    // the sprite size. Lite does NOT inset, so matching parity requires
    // disabling epsilon here.
    const renderer = new SpriteRenderer(engine, 256, 0, null);
    renderer.texture = texture;
    renderer.cellWidth = SPRITE_ATLAS_INFO.cellWidthPx;
    renderer.cellHeight = SPRITE_ATLAS_INFO.cellHeightPx;
    // SpriteRenderer enables a depth-prepass by default — pointless for a
    // pure 2D scene with no depth target. Disable to match Lite's
    // `depth: "none"` on the sprite layer.
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
            // Match Lite's per-sprite size variation: every 11th sprite is larger.
            const sizePx = idx % 11 === 0 ? 40 : 28;

            const sprite = new ThinSprite();
            sprite.position = new Vector3(
                ox + c * cellPx,
                // Y-up projection below (+Y is up in world) but the Lite scene
                // uses pixel-space where +Y is down. Flip here instead of in
                // the projection, which would otherwise flip sprite UVs too.
                canvas.height - (oy + r * cellPx),
                0
            );
            sprite.width = sizePx;
            sprite.height = sizePx;
            sprite.cellIndex = frame;
            // Negate angle: Lite uses canvas convention (positive angle = CW).
            // Our Y-up projection flips the rotation direction, so negate here.
            sprite.angle = idx % 5 === 0 ? -Math.PI / 6 : 0;
            // Lite's flipX maps to `invertU` on ThinSprite.
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

    // View + projection: world units == canvas pixel units, with +Y up
    // (sprite Y positions above are flipped to compensate). OrthoOffCenterLH
    // matches the left-handed default that SpriteRenderer assumes when
    // `scene: null` is passed.
    //
    // `halfZRange` is critical: WebGPU NDC Z is [0, 1], OpenGL NDC Z is
    // [-1, 1]. Without a Scene/Camera to fix this up, we must feed the
    // engine-appropriate convention directly. Otherwise half the Z range
    // is clipped and nothing is drawn on WebGPU.
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
        // `renderer.render` is a no-op until both the WGSL shaders and the
        // texture are ready. Wait for a real draw before signalling ready.
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
