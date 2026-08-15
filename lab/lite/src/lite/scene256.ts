// Scene 256 — NormalTangentTest (cx20 gltf-test parity)
//
// Khronos NormalTangentTest.gltf: a single mesh with a single glTF material
// (one baseColorTexture, one combined occlusion/roughness/metallic texture,
// one normalTexture) — a grid comparing cells with real sculpted bump
// geometry against flat normal-mapped cells, plus a labelled "Front" plane,
// all baked into that one mesh/material/texture set. The mesh ships
// NORMAL + TEXCOORD_0 but no TANGENT accessor — this is the model's whole
// point: it tests an engine's ability to auto-generate a tangent basis at
// render time (screen-space derivative / cotangent-frame method) rather than
// relying on precomputed tangents. See docs/lite/architecture/06-pbr-material.md
// (`_normalMode: "cotangent"` / `PBR_HAS_COTANGENT_NORMAL`) for the cotangent
// frame math, and scene23 (anisotropy) for another scene whose parity is
// sensitive to the same dpdx/dpdy cotangent-frame precision.
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/tutorialModels/NormalTangentTest/glTF/NormalTangentTest.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 4.6377, { x: 0, y: -0.125, z: 0.03525 });
    cam.fov = 0.8;
    cam.nearPlane = 4.6377 * 0.01;
    cam.farPlane = 4.6377 * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
