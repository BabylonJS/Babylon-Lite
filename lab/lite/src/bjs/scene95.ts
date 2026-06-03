// Reference scene 95 — Babylon.js SpriteManager billboards with a baked palette atlas.
//
// Mirrors lab/src/bjs/scene54.ts (same camera, boxes, sprite layout) but uses
// the hard-alpha cutout atlas and bakes the same 256-entry colormap remap into
// the atlas pixels on a canvas (RGB := palette[redByte], alpha preserved).
// Rendered with nearest filtering, this is bit-exact with Lite's WGSL
// `palette[texel.r]` lookup.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";
import { bakeRemappedAtlasDataUrl, buildColormapPalette } from "../_shared/palette-remap";

const CAMERA_ALPHA = -Math.PI / 3;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.16, 0.18, 0.22, 1);

    const camera = new ArcRotateCamera("cam", CAMERA_ALPHA, 1.35, 8, new Vector3(0.2, 0.05, 0), scene);
    camera.fov = 0.8;
    camera.minZ = 1;
    camera.maxZ = 100;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.9;

    const centerBox = MeshBuilder.CreateBox("center", { size: 1.65 }, scene);
    centerBox.position = new Vector3(0, -0.05, -1.05);
    const centerMaterial = new StandardMaterial("centerMat", scene);
    centerMaterial.diffuseColor = new Color3(0.5, 0.55, 0.62);
    centerBox.material = centerMaterial;

    const sideBox = MeshBuilder.CreateBox("side", { size: 0.85 }, scene);
    sideBox.position = new Vector3(1.65, -0.65, 0.55);
    const sideMaterial = new StandardMaterial("sideMat", scene);
    sideMaterial.diffuseColor = new Color3(0.26, 0.42, 0.72);
    sideBox.material = sideMaterial;

    const bakedAtlasUrl = await bakeRemappedAtlasDataUrl(getCutoutSpriteAtlasDataUrl(), buildColormapPalette());
    const manager = new SpriteManager("billboards", bakedAtlasUrl, 6, { width: CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx, height: CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx }, scene, 0, Texture.NEAREST_SAMPLINGMODE);
    manager.disableDepthWrite = true;

    addSprite(manager, "front-left", [-1.6, 0.7, -2.15], [1.25, 0.8], 0, 0, [1, 1, 1, 0.95]);
    addSprite(manager, "center-behind", [0, 0.05, 0.15], [1.65, 1.05], 3, 0, [1, 1, 1, 0.9]);
    addSprite(manager, "far-right", [1.65, -0.25, 1.45], [1.35, 0.95], 5, 0, [1, 1, 1, 0.88], true, false);
    addSprite(manager, "low-back", [-0.55, -0.95, 1.05], [0.95, 1.25], 7, 0, [1, 1, 1, 0.82], false, true);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame: () => void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});

function addSprite(
    manager: SpriteManager,
    name: string,
    position: readonly [number, number, number],
    size: readonly [number, number],
    frame: number,
    rotation: number,
    color: readonly [number, number, number, number],
    flipX = false,
    flipY = false
): Sprite {
    const sprite = new Sprite(name, manager);
    sprite.position = new Vector3(position[0], position[1], position[2]);
    sprite.width = size[0];
    sprite.height = size[1];
    sprite.cellIndex = frame;
    sprite.angle = rotation;
    sprite.color = new Color4(color[0], color[1], color[2], color[3]);
    sprite.invertU = flipX;
    sprite.invertV = flipY;
    sprite.isVisible = true;
    return sprite;
}
