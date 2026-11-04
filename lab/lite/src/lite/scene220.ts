// Scene 220 — Duck (glTF-Quantized, cx20 gltf-test parity)
// KHR_mesh_quantization + KHR_texture_transform: POSITION/NORMAL are quantized
// (POSITION: unnormalized strided UNSIGNED_SHORT VEC3 dequantized via the node's
// TRS; NORMAL: normalized BYTE VEC3), and TEXCOORD_0 is an UNNORMALIZED
// UNSIGNED_SHORT VEC2 whose raw integer values are rescaled back into [0,1] by a
// KHR_texture_transform on the material (gltfpack's standard quantized-UV output).
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/sampleModels/Duck/glTF-Quantized/Duck.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 2.2, { x: 0.135, y: 0.87, z: -0.04 });
    cam.fov = 0.8;
    cam.nearPlane = 2.2 * 0.01;
    cam.farPlane = 2.2 * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
