// Scene 17: PBR + Standard Thin Instances — mixed materials with per-instance color
//
// Cube 1 (PBR): gold metallic material + env IBL, 2 thin instances (yellow/red)
// Cube 2 (Std): default standard material, 2 thin instances (green/blue), negative X scale
// Ground: 6×6 standard material

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, createBox, createGround, createPbrMaterial, createStandardMaterial, createSolidTexture2D, loadTexture2D, setThinInstances, setThinInstanceColors, attachControl, mat4Identity, mat4Translation, mat4Compose, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Thin instances are now handled automatically by the fragment composer —
    // no registration needed.

    // Camera: FreeCamera(0,5,-10) → target(0,0,0) equivalent
    // Lite formula: x=r*cos(a)*sin(b), y=r*cos(b), z=r*sin(a)*sin(b)
    // For pos (0,5,-10): alpha=-π/2, beta=atan(2), radius=√125
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.atan(2), Math.sqrt(125), { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Hemispheric light
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    // Environment for PBR IBL — load DDS prefiltered cubemap (matching BJS scene)
    await loadDdsEnvironment(scene, "https://playground.babylonjs.com/textures/environment.dds", {
        brdfUrl: "/brdf-lut.png",
    });

    // ── Cube 1: PBR material with thin instances ──
    const cube1 = createBox(engine);
    cube1.position.set(0, 1, 0);

    const baseColorTex = createSolidTexture2D(engine, 1.0, 0.766, 0.336);
    const ormTex = await loadTexture2D(engine, "https://playground.babylonjs.com/textures/mr.jpg");
    cube1.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        occlusionStrength: 0,
    });

    // 2 instances: Translation(-2,2,0) and Identity
    const matrices1 = new Float32Array(16 * 2);
    const m1 = mat4Translation(-2, 2, 0);
    matrices1.set(m1, 0);
    const m2 = mat4Identity();
    matrices1.set(m2, 16);
    setThinInstances(cube1, matrices1, 2);

    const colors1 = new Float32Array([1, 1, 0, 1, 1, 0, 0, 1]); // yellow, red
    setThinInstanceColors(cube1, colors1);
    addToScene(scene, cube1);

    // ── Cube 2: Standard material with thin instances ──
    const cube2 = createBox(engine);
    cube2.position.set(0, 1, 0);

    const stdMat = createStandardMaterial();
    stdMat.backFaceCulling = false; // matches BJS ClockWiseSideOrientation with negative scale
    cube2.material = stdMat;

    // 2 instances with negative X scale: Compose(s=(-1,1,1), q=identity, t=(2,1,0)) and (s=(-1,1,1), q=identity, t=(-2,0,-3))
    const matrices2 = new Float32Array(16 * 2);
    const m3 = mat4Compose(2, 1, 0, 0, 0, 0, 1, -1, 1, 1);
    matrices2.set(m3, 0);
    const m4 = mat4Compose(-2, 0, -3, 0, 0, 0, 1, -1, 1, 1);
    matrices2.set(m4, 16);
    setThinInstances(cube2, matrices2, 2);

    const colors2 = new Float32Array([0, 1, 0, 1, 0, 0, 1, 1]); // green, blue
    setThinInstanceColors(cube2, colors2);
    addToScene(scene, cube2);

    // ── Ground ──
    const ground = createGround(engine, { width: 6, height: 6 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
