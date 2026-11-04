// Babylon.js reference for Scene 267: StandardMaterial Vertex Colors.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";

const POSITIONS = [-3, -2, 0, 3, -2, 0, -3, 2, 0, 3, 2, 0];
const NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
const INDICES = [0, 1, 2, 1, 3, 2];
const COLORS = [
    0, 0, 1, 1,
    1, 0, 1, 1,
    0, 1, 0, 1,
    1, 1, 0, 1,
];

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.04, 0.07, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 3, Vector3.Zero(), scene);
    camera.fov = 0.8;
    camera.minZ = 0.1;
    camera.maxZ = 10;
    scene.activeCamera = camera;

    const quad = new Mesh("vertex-color-quad", scene);
    const vertexData = new VertexData();
    vertexData.positions = POSITIONS;
    vertexData.normals = NORMALS;
    vertexData.indices = INDICES;
    vertexData.colors = COLORS;
    vertexData.applyToMesh(quad);

    const material = new StandardMaterial("vertex-color-standard", scene);
    material.diffuseColor = Color3.White();
    material.emissiveColor = Color3.White();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.backFaceCulling = false;
    quad.material = material;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.ready = "true";
})().catch(console.error);
