// HPM jitter parity scene shared builder.
//
// Both scene200 (HPM-off) and scene201 (HPM-on) instantiate this builder
// with a single boolean flag. The scene places a textured box at world
// coordinates ~1e6 with the camera 8 m away from it, aimed at the box.
// At this magnitude single-precision storage of the camera/world matrix
// chain quantises positions enough that pixel-level differences appear
// between HPM-off (F32 storage) and HPM-on (F64 storage + late F32 pack)
// for the same rendered frame.
//
// The scene is fully deterministic: no animation, no input, single steady
// frame. `canvas.dataset.ready = "true"` is set after the first frame so
// the parity harness can screenshot.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createGround,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "babylon-lite";

const FAR_X = 1_000_000;
const FAR_Z = 1_000_000;

export interface HpmJitterOptions {
    useHighPrecisionMatrix: boolean;
}

export async function runHpmJitterScene(opts: HpmJitterOptions): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, {
        useHighPrecisionMatrix: opts.useHighPrecisionMatrix,
    });
    const scene = createSceneContext(engine);

    // Camera orbits around the far box at a small radius — eye position is
    // (FAR_X + cos*8, ..., FAR_Z + sin*8), so the view matrix translation
    // is order-1e6 in magnitude, which is where F32 vs F64 storage of the
    // composed view/viewProj chain diverges visibly.
    const cam = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 8, { x: FAR_X, y: 1, z: FAR_Z });
    cam.nearPlane = 0.1;
    cam.farPlane = 200;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    const light = createDirectionalLight([-0.4, -1, -0.2]);
    light.diffuse = [1, 1, 1];
    light.specular = [0.2, 0.2, 0.2];
    addToScene(scene, light);

    // Reference ground at origin — far off-screen, but keeps the scene
    // geometry-balanced and ensures the depth buffer range exercises both
    // near and far clip values consistently between variants.
    const ground = createGround(engine, { width: 8, height: 8, subdivisions: 1 });
    ground.material = createStandardMaterial();
    ground.material.diffuseColor = [0.2, 0.2, 0.25];
    ground.position.set(FAR_X, 0, FAR_Z);
    addToScene(scene, ground);

    // Tall pillar at the far world position — its silhouette is what the
    // parity diff sees. A simple emissive pattern makes precision-driven
    // edge shifts more visible than a flat-shaded surface would.
    const pillar = createBox(engine, 1);
    pillar.material = createStandardMaterial();
    pillar.material.diffuseColor = [0.8, 0.4, 0.2];
    pillar.material.emissiveColor = [0.1, 0.05, 0.02];
    pillar.material.specularColor = [0.6, 0.6, 0.6];
    pillar.position.set(FAR_X, 1.5, FAR_Z);
    pillar.scaling.set(0.6, 3, 0.6);
    addToScene(scene, pillar);

    // Smaller satellite cubes around the pillar — vertical and horizontal
    // offset so the rasterizer evaluates edges at sub-pixel positions where
    // F32 chain-rounding shows up most.
    for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2;
        const sat = createBox(engine, 1);
        sat.material = createStandardMaterial();
        sat.material.diffuseColor = [0.3, 0.7, 0.9];
        sat.position.set(FAR_X + Math.cos(angle) * 2, 0.4, FAR_Z + Math.sin(angle) * 2);
        sat.scaling.set(0.4, 0.8, 0.4);
        addToScene(scene, sat);
    }

    await registerScene(engine, scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.useHighPrecisionMatrix = String(engine.useHighPrecisionMatrix);
    canvas.dataset.ready = "true";
}
