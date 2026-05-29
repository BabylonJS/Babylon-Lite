// Scene 36: Basis Universal Texture — matches Babylon #4RN0VF
// Box with a .basis texture as both diffuse and emissive. Tests the
// Basis Universal transcoder path (fetched from BJS CDN at runtime).

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    createHemisphericLight,
    createBox,
    createStandardMaterial,
    loadBasisTexture2D,
    registerScene,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: ArcRotate at (3π/2, π/2, 60), target origin.
    scene.camera = createArcRotateCamera((3 * Math.PI) / 2, Math.PI / 2, 60, { x: 0, y: 0, z: 0 });
    attachControl(scene.camera, canvas, scene);

    // Light: hemispheric pointing up, intensity 0.7.
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    // Load the .basis texture (transcoded to the best GPU-supported format).
    const basisTex = await loadBasisTexture2D(engine, "https://playground.babylonjs.com/textures/plane.basis");

    const mat = createStandardMaterial();
    mat.diffuseTexture = basisTex;
    mat.emissiveTexture = basisTex;

    // Box: size 30, stretched on X to match source image aspect (768/512).
    const box = createBox(engine, 30);
    box.scaling.x = 768 / 512;
    box.material = mat;
    addToScene(scene, box);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
