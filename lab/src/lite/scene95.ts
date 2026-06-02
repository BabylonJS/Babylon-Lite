// Scene 95 — Billboard Custom Shader (palette / colormap remap)
//
// The facing-billboard scene from scene 54, but drawn with a custom fragment
// shader that recolours every atlas texel through a 256×1 palette lookup
// texture: the atlas sample's red channel indexes the palette, the result keeps
// the source alpha, and the per-sprite tint multiplies on top. Uses the
// hard-alpha cutout atlas with nearest filtering so the lookup is bit-exact.
//
// Parity oracle: BJS SpriteManager renders the same billboards with a pre-baked
// atlas whose pixels were remapped through the identical palette on a canvas.

import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    createArcRotateCamera,
    createBillboardCustomShader,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    loadSpriteAtlas,
    registerScene,
    startEngine,
} from "babylon-lite";
import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";
import { buildColormapPalette, PALETTE_WIDTH } from "../_shared/palette-remap";

const CAMERA_ALPHA = -Math.PI / 3;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.16, g: 0.18, b: 0.22, a: 1 };

    scene.camera = createArcRotateCamera(CAMERA_ALPHA, 1.35, 8, { x: 0.2, y: 0.05, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 100;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const centerBox = createBox(engine, 1.65);
    centerBox.position.set(0, -0.05, -1.05);
    const centerMaterial = createStandardMaterial();
    centerMaterial.diffuseColor = [0.5, 0.55, 0.62];
    centerBox.material = centerMaterial;
    addToScene(scene, centerBox);

    const sideBox = createBox(engine, 0.85);
    sideBox.position.set(1.65, -0.65, 0.55);
    const sideMaterial = createStandardMaterial();
    sideMaterial.diffuseColor = [0.26, 0.42, 0.72];
    sideBox.material = sideMaterial;
    addToScene(scene, sideBox);

    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {
        gridSize: [CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx, CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "nearest",
    });

    const paletteTexture = createTexture2DFromPixels(engine, buildColormapPalette(), PALETTE_WIDTH, 1);

    const customShader = createBillboardCustomShader({
        fragment: `let texel = textureSample(atlasTex, atlasSamp, in.uv);
let pal = textureSample(paletteTex, paletteSamp, vec2<f32>(texel.r, 0.5));
return vec4<f32>(pal.rgb, texel.a) * in.tint;`,
        extraTextures: [{ name: "palette", texture: paletteTexture }],
    });

    const billboards = createFacingBillboardSystem(atlas, { capacity: 6, customShader });

    addBillboardSpriteIndex(billboards, {
        position: [-1.6, 0.7, -2.15],
        sizeWorld: [1.25, 0.8],
        frame: 0,
        color: [1, 1, 1, 0.95],
    });
    addBillboardSpriteIndex(billboards, {
        position: [0, 0.05, 0.15],
        sizeWorld: [1.65, 1.05],
        frame: 3,
        color: [1, 1, 1, 0.9],
    });
    addBillboardSpriteIndex(billboards, {
        position: [1.65, -0.25, 1.45],
        sizeWorld: [1.35, 0.95],
        frame: 5,
        color: [1, 1, 1, 0.88],
        flipX: true,
    });
    addBillboardSpriteIndex(billboards, {
        position: [-0.55, -0.95, 1.05],
        sizeWorld: [0.95, 1.25],
        frame: 7,
        pivot: [0.5, 0.62],
        color: [1, 1, 1, 0.82],
        flipY: true,
    });
    addFacingBillboardSystem(scene, billboards);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
