// Scene 93 — Sprite Custom Shader (palette / colormap remap)
//
// The pure-2D sprite grid from scene 50, but drawn with a custom fragment shader
// that recolours every atlas texel through a 256×1 palette lookup texture: the
// atlas sample's red channel indexes the palette, the result keeps the source
// alpha, and the per-sprite tint multiplies on top. Uses the hard-alpha cutout
// atlas with nearest filtering so the lookup is bit-exact (no partial-alpha
// pixels, no interpolation between palette entries).
//
// Parity oracle: BJS renders the same grid via SpriteRenderer with a pre-baked
// atlas whose pixels were remapped through the identical palette on a canvas.

import {
    createEngine,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteRenderer,
    createTexture2DFromPixels,
    loadSpriteAtlas,
    registerSpriteRenderer,
    startEngine,
} from "babylon-lite";
import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";
import { addDeterministicSpriteGrid } from "../_shared/sprite-grid";
import { buildColormapPalette, PALETTE_WIDTH } from "../_shared/palette-remap";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {
        gridSize: [CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx, CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "nearest",
    });

    const paletteTexture = createTexture2DFromPixels(engine, buildColormapPalette(), PALETTE_WIDTH, 1);

    const customShader = createSprite2DCustomShader({
        fragment: `let texel = textureSample(atlasTex, atlasSamp, in.uv);
let pal = textureSample(paletteTex, paletteSamp, vec2<f32>(texel.r, 0.5));
return vec4<f32>(pal.rgb, texel.a) * in.tint;`,
        extraTextures: [{ name: "palette", texture: paletteTexture }],
    });

    const layer = createSprite2DLayer(atlas, { capacity: 256, depth: "none", customShader });
    addDeterministicSpriteGrid(layer, canvas, { frameForIndex: (index) => index % 8 });

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
