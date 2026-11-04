// Babylon.js reference for scene 282: StandardMaterial texture scale, offset, and rotation.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { buildTexturePixels, TEXTURE_SIZE, UV_OFFSET, UV_ROTATION, UV_SCALE } from "../shared/scene282-standard-uv-transform.js";

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.035, 0.045, 0.07, 1);
    scene.activeCamera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 4, Vector3.Zero(), scene);

    const texture = RawTexture.CreateRGBATexture(buildTexturePixels(), TEXTURE_SIZE, TEXTURE_SIZE, scene, false, true, Texture.NEAREST_SAMPLINGMODE);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.uScale = UV_SCALE[0];
    texture.vScale = UV_SCALE[1];
    texture.uOffset = UV_OFFSET[0];
    texture.vOffset = UV_OFFSET[1];
    texture.wAng = -UV_ROTATION;
    texture.uRotationCenter = 0;
    texture.vRotationCenter = 0;

    const material = new StandardMaterial("standard-uv-transform", scene);
    material.disableLighting = true;
    material.diffuseColor = Color3.White();
    material.emissiveColor = Color3.White();
    material.diffuseTexture = texture;

    const plane = MeshBuilder.CreatePlane("standard-uv-transform-plane", { width: 3, height: 3 }, scene);
    plane.material = material;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
