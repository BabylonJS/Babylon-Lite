// Scene 202 — Side-by-side LWR (Large World Rendering) demonstration.
//
// One canvas, one engine with `useHighPrecisionMatrix: true`, two scenes
// drawn into split viewports of the same swapchain:
//
//   LEFT  (x=0..0.5)   — `useFloatingOrigin: false` — control.
//   RIGHT (x=0.5..1)   — `useFloatingOrigin: true`  — LWR path under test.
//
// Both scenes are placed at world (OFFSET, *, OFFSET) with identical
// geometry: a 5×5 grid of boxes + ground + rotating box. The right scene
// subtracts the camera world position from every uploaded matrix at pack
// time (and bakes the same offset into the view matrix construction), so
// the GPU vertex shader sees small-magnitude inputs and the rasterizer
// emits crisp edges. The left scene uploads raw world coordinates; F32
// rounding on the view × world product produces visible stair-stepping
// at this magnitude.
//
// The two cameras are synced each frame so any orbit drag, zoom, or pan
// the user (or test harness) applies to the left camera is mirrored on
// the right — making the divergence purely a function of LWR being on
// vs off.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera, SceneContext } from "babylon-lite";

/** World offset where both scenes are centred. 5e6 matches the BJS reference
 *  playground (5U0N0Q#5) and is the magnitude at which F32 rounding of a
 *  view × world product becomes visible to the eye. */
const OFFSET = 5_000_000;

interface BuiltScene {
    scene: SceneContext;
    camera: ArcRotateCamera;
}

function buildScene(engine: Parameters<typeof createSceneContext>[0], useFloatingOrigin: boolean): BuiltScene {
    const scene = createSceneContext(engine, { useFloatingOrigin });
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

    const camera = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 25, { x: OFFSET, y: 1, z: OFFSET });
    camera.nearPlane = 0.5;
    camera.farPlane = 500;
    scene.camera = camera;

    const hemi = createHemisphericLight([0, 1, 0], 0.4);
    addToScene(scene, hemi);

    const dir = createDirectionalLight([-0.4, -1, -0.2]);
    dir.diffuse = [1, 1, 1];
    dir.specular = [0.3, 0.3, 0.3];
    addToScene(scene, dir);

    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 1 });
    ground.material = createStandardMaterial();
    ground.material.diffuseColor = [0.25, 0.25, 0.3];
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // 5×5 grid of boxes. Spacing 4m. Centred on (OFFSET, 1, OFFSET).
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const box = createBox(engine, 1);
            box.material = createStandardMaterial();
            // Colour-code so the eye can spot per-cube edge shifts between
            // the two halves at a glance.
            const r = 0.3 + (i / 4) * 0.6;
            const g = 0.4;
            const b = 0.3 + (j / 4) * 0.6;
            box.material.diffuseColor = [r, g, b];
            box.material.specularColor = [0.4, 0.4, 0.4];
            box.position.set(OFFSET + (i - 2) * 4, 1, OFFSET + (j - 2) * 4);
            addToScene(scene, box);
        }
    }

    // Centre marker — taller and brighter so the eye-anchor for jitter is
    // unambiguous. F32 rounding shifts the rasterized silhouette by a full
    // pixel or more at OFFSET=5e6.
    const pillar = createBox(engine, 1);
    pillar.material = createStandardMaterial();
    pillar.material.diffuseColor = [0.9, 0.5, 0.2];
    pillar.material.emissiveColor = [0.1, 0.05, 0.02];
    pillar.material.specularColor = [0.6, 0.6, 0.6];
    pillar.position.set(OFFSET, 2, OFFSET);
    pillar.scaling.set(0.8, 4, 0.8);
    addToScene(scene, pillar);

    return { scene, camera };
}

export async function runLwrSideBySideScene(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true });

    const left = buildScene(engine, false);
    const right = buildScene(engine, true);

    left.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
    right.camera.viewport = { x: 0.5, y: 0, width: 0.5, height: 1 };

    // Camera sync — drive the right camera from the left so any orbit/pan
    // applied to the left half is mirrored. The left scene's beforeRender
    // is the earliest scene-attached hook each frame.
    onBeforeRender(left.scene, () => {
        right.camera.alpha = left.camera.alpha;
        right.camera.beta = left.camera.beta;
        right.camera.radius = left.camera.radius;
        right.camera.target.x = left.camera.target.x;
        right.camera.target.y = left.camera.target.y;
        right.camera.target.z = left.camera.target.z;
    });

    await registerScene(engine, left.scene);
    await registerScene(engine, right.scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.offset = String(OFFSET);
    canvas.dataset.ready = "true";
}
