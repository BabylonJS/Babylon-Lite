// Scene 214: Cascaded Shadow Maps (CSM) for a directional light — torus-knot field.
//
// Mirrors playground #KY0N7T#84: a large Standard ground receiver under a field
// of 200 green torus-knot casters scattered across a 2000-unit area, lit by a
// single DirectionalLight with a 4-cascade CascadedShadowGenerator (PCF5). A
// non-caster "Base" knot sits at the origin. All caster transforms come from a
// seeded mulberry32 PRNG (NOT Math.random) drawn in the SAME order as the BJS
// oracle, and rotations are applied as quaternions computed with Babylon's
// YawPitchRoll convention, so the Lite render and the BJS golden match
// pixel-for-pixel. The directional light auto-fits the cascade Z bounds to the
// caster AABB (BJS autoCalcShadowZBounds = true; depthClamp = false).

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createTorusKnot,
    createGround,
    createDirectionalLight,
    createCsmDirectionalShadowGenerator,
    createStandardMaterial,
    attachControl,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
} from "babylon-lite";
import type { ArcRotateCamera, Mesh } from "babylon-lite";

const SCENE_SIZE = 2000;
const NUM_CASTERS = 200;
const PRNG_SEED = 1337;

/** Deterministic mulberry32 PRNG — same algorithm/seed/draw-order as the BJS oracle. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Euler (Babylon YawPitchRoll: yaw=y, pitch=x, roll=z) → quaternion [x,y,z,w]. */
function quatFromEuler(ex: number, ey: number, ez: number): [number, number, number, number] {
    const hr = ez * 0.5,
        hp = ex * 0.5,
        hy = ey * 0.5;
    const sr = Math.sin(hr),
        cr = Math.cos(hr),
        sp = Math.sin(hp),
        cp = Math.cos(hp),
        sy = Math.sin(hy),
        cy = Math.cos(hy);
    return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.5, g: 0.6, b: 0.75, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, SCENE_SIZE * 1.1, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const light = createDirectionalLight([0, -1, -1], 0.8);
    addToScene(scene, light);

    const ground = createGround(engine, { width: SCENE_SIZE, height: SCENE_SIZE });
    ground.receiveShadows = true;
    const groundMat = createStandardMaterial();
    ground.material = groundMat;

    // Shared green Standard material (only diffuseColor set; BJS specular defaults kept).
    const knotMat = createStandardMaterial();
    knotMat.diffuseColor = [0, 1, 0];

    // Non-caster base knot at the origin (template mesh in the playground).
    const base = createTorusKnot(engine, { radius: 20, tube: 5 });
    base.material = knotMat;
    addToScene(scene, base);

    const rand = mulberry32(PRNG_SEED);
    const casters: Mesh[] = [];
    for (let i = 0; i < NUM_CASTERS; i++) {
        const px = (rand() - 0.5) * SCENE_SIZE;
        const py = rand() * SCENE_SIZE * 0.25 + 1;
        const pz = (rand() - 0.5) * SCENE_SIZE;
        const ex = rand() * 3.14;
        const ey = rand() * 3.14;
        const ez = rand() * 3.14;

        const knot = createTorusKnot(engine, { radius: 20, tube: 5 });
        knot.material = knotMat;
        knot.position.set(px, py, pz);
        const [qx, qy, qz, qw] = quatFromEuler(ex, ey, ez);
        knot.rotationQuaternion.set(qx, qy, qz, qw);
        addToScene(scene, knot);
        casters.push(knot);
    }

    light.shadowGenerator = createCsmDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        numCascades: 4,
        lambda: 0.5,
        cascadeBlendPercentage: 0.1,
        bias: 0.00005,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, casters);

    addToScene(scene, ground);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
