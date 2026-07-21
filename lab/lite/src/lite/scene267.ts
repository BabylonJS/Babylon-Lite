// Scene 267 — StandardMaterial Vertex Colors

import { addToScene, createArcRotateCamera, createEngine, createMeshFromData, createSceneContext, createStandardMaterial, registerScene, startEngine } from "babylon-lite";
import { enableStandardVertexColors } from "babylon-lite/material/standard/enable-standard-vertex-colors";

const POSITIONS = new Float32Array([-3, -2, 0, 3, -2, 0, -3, 2, 0, 3, 2, 0]);
const NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const INDICES = new Uint32Array([0, 1, 2, 1, 3, 2]);
const COLORS = new Float32Array([
    0, 0, 1, 1,
    1, 0, 1, 1,
    0, 1, 0, 1,
    1, 1, 0, 1,
]);

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.03, g: 0.04, b: 0.07, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 3, { x: 0, y: 0, z: 0 });
    camera.fov = 0.8;
    camera.nearPlane = 0.1;
    camera.farPlane = 10;
    scene.camera = camera;

    const quad = createMeshFromData(engine, "vertex-color-quad", POSITIONS, NORMALS, INDICES, undefined, undefined, undefined, COLORS);
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [1, 1, 1];
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    material.backFaceCulling = false;
    quad.material = material;
    addToScene(scene, quad);

    enableStandardVertexColors();
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
