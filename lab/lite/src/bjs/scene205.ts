// BJS reference for scene 205 — floating-origin facing billboard sprites.
//
// Mirrors lab/lite/src/lite/scene205.ts exactly. The ONE intended substrate
// difference is `useLargeWorldRendering: true` on the engine, which enables
// BJS's high-precision-matrix + floating-origin mode. Under that mode BJS's
// SpriteRenderer subtracts `scene.floatingOriginOffset` (the active camera
// position) from every sprite's world position before upload, so the GPU sees
// eye-relative anchors — the exact behaviour scene205.ts asserts for Lite.
//
// IMPORTANT: every geometry/material/camera/atlas/sprite parameter below MUST
// stay in sync with lab/lite/src/lite/scene205.ts.
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

import "@babylonjs/core/Engines/Extensions/engine.alpha";
import "@babylonjs/core/ShadersWGSL/sprites.vertex";
import "@babylonjs/core/ShadersWGSL/sprites.fragment";

import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

/** Mirrors `OFFSET` in lab/lite/src/lite/scene205.ts. */
const OFFSET = 5_000_000;
const CAMERA_ALPHA = -Math.PI / 3;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true, useLargeWorldRendering: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.16, 0.18, 0.22, 1);

    const camera = new ArcRotateCamera("cam", CAMERA_ALPHA, 1.35, 8, new Vector3(OFFSET + 0.2, 0.05, OFFSET), scene);
    camera.fov = 0.8;
    camera.minZ = 1;
    camera.maxZ = 100;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.9;

    const centerBox = MeshBuilder.CreateBox("center", { size: 1.65 }, scene);
    centerBox.position = new Vector3(OFFSET, -0.05, OFFSET - 1.05);
    const centerMaterial = new StandardMaterial("centerMat", scene);
    centerMaterial.diffuseColor = new Color3(0.5, 0.55, 0.62);
    centerBox.material = centerMaterial;

    const sideBox = MeshBuilder.CreateBox("side", { size: 0.85 }, scene);
    sideBox.position = new Vector3(OFFSET + 1.65, -0.65, OFFSET + 0.55);
    const sideMaterial = new StandardMaterial("sideMat", scene);
    sideMaterial.diffuseColor = new Color3(0.26, 0.42, 0.72);
    sideBox.material = sideMaterial;

    const manager = new SpriteManager("billboards", getSpriteAtlasDataUrl(), 6, { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx }, scene, 0);
    manager.disableDepthWrite = true;

    addSprite(manager, "front-left", [OFFSET - 1.5, 0.7, OFFSET - 2.0], [1.25, 0.8], 8, 0, [1, 1, 1, 0.95]);
    addSprite(manager, "center-behind", [OFFSET, 0.05, OFFSET], [1.65, 1.05], 13, 0, [1, 1, 1, 0.9]);
    addSprite(manager, "far-right", [OFFSET + 1.5, -0.25, OFFSET + 1.5], [1.35, 0.95], 18, 0, [1, 1, 1, 0.88], true, false);
    addSprite(manager, "low-back", [OFFSET - 0.5, -0.95, OFFSET + 1.0], [0.95, 1.25], 26, 0, [1, 1, 1, 0.82], false, true);

    engine.runRenderLoop(() => scene.render());

    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.initMs = String(performance.now() - __initStart);
        canvas.dataset.offset = String(OFFSET);
        canvas.dataset.useLargeWorldRendering = "true";
        canvas.dataset.ready = "true";
    });
})();

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
