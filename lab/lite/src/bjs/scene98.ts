// Reference scene 98 — Babylon.js SpriteManager billboards with additive blend.
//
// Mirrors lab/src/bjs/scene94.ts (same camera, boxes, engine settings) but uses
// the ALPHA_ONEONE blend mode and pre-multiplies every sprite's RGB by its own
// alpha. For the fully-opaque icon cells this makes BJS's `one * (rgb*a)` equal
// to Lite's `src-alpha * rgb` (src.a = texel.a*color.a = color.a), so the
// additive accumulation where billboards overlap is pixel-identical.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
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

const CAMERA_ALPHA = -Math.PI / 3;

interface RefBillboard {
    position: readonly [number, number, number];
    size: readonly [number, number];
    frame: number;
    color: readonly [number, number, number, number];
}

const BILLBOARDS: readonly RefBillboard[] = [
    { position: [-0.6, 0.2, 2.2], size: [2.2, 2.2], frame: 9, color: [1.0, 0.5, 0.4, 0.8] },
    { position: [0.4, 0.0, 2.0], size: [2.2, 2.2], frame: 14, color: [0.4, 0.8, 1.0, 0.8] },
    { position: [-0.1, -0.4, 1.8], size: [2.0, 2.0], frame: 18, color: [0.6, 1.0, 0.5, 0.7] },
    { position: [0.9, 0.5, 2.4], size: [1.8, 1.8], frame: 11, color: [1.0, 0.9, 0.3, 0.7] },
    { position: [-0.9, -0.2, 2.6], size: [1.6, 1.6], frame: 21, color: [0.8, 0.4, 1.0, 0.7] },
];

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

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

    const manager = new SpriteManager(
        "billboards",
        getSpriteAtlasDataUrl(),
        BILLBOARDS.length,
        { width: SPRITE_ATLAS_INFO.cellWidthPx, height: SPRITE_ATLAS_INFO.cellHeightPx },
        scene,
        0
    );
    manager.disableDepthWrite = true;
    manager.blendMode = Constants.ALPHA_ONEONE;

    for (const bb of BILLBOARDS) {
        const sprite = new Sprite("bb", manager);
        sprite.position = new Vector3(bb.position[0], bb.position[1], bb.position[2]);
        sprite.width = bb.size[0];
        sprite.height = bb.size[1];
        sprite.cellIndex = bb.frame;
        // Pre-multiply RGB by alpha so ALPHA_ONEONE (one,one) matches Lite's (src-alpha,one).
        sprite.color = new Color4(bb.color[0] * bb.color[3], bb.color[1] * bb.color[3], bb.color[2] * bb.color[3], bb.color[3]);
        sprite.isVisible = true;
    }

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
