// Scene 209 — Floating-origin Havok physics (multi-region).
//
// LWR feature coverage: **Havok rigid-body simulation under floating origin**.
// The whole scene (sphere + ground) sits at world (~5e6, *, ~5e6). A dynamic
// sphere drops onto a static ground and settles. Without floating origin the
// body would be simulated at raw world coordinates (order 5e6), where float32
// Havok loses precision and the sphere jitters / never settles cleanly. With
// `useFloatingOrigin: true` the physics world picks a region centred near the
// bodies and simulates them relative to that origin (local coords near zero),
// so the solver keeps full precision and the sphere settles exactly on the
// ground — matching BJS `useLargeWorldRendering` (which enables Havok
// multi-region floating origin via `scene.floatingOriginMode`).
//
// Paired BJS reference: lab/lite/src/bjs/scene209.ts.
// Geometry, materials, camera, light and physics config MUST stay in sync.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    enableHavokFloatingOrigin,
    onBeforeRender,
    PhysicsShapeType,
    registerScene,
    startEngine,
} from "babylon-lite";

const OFFSET = 5_000_000;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);

    // Camera framing mirrors scene40, shifted to the OFFSET location.
    scene.camera = createFreeCamera({ x: OFFSET, y: 5, z: OFFSET - 10 }, { x: OFFSET, y: 0, z: OFFSET });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    // Sphere — diameter 2, starts 4 units above the ground (will drop via physics).
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.material = createStandardMaterial();
    sphere.position.set(OFFSET, 4, OFFSET);
    addToScene(scene, sphere);

    // Ground — 10x10 receiver at the OFFSET location.
    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = createStandardMaterial();
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // Havok physics — opt into multi-region floating origin (must precede body creation).
    // Pairs with the engine's useFloatingOrigin:true for far-from-origin rendering.
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });
    await enableHavokFloatingOrigin(world);

    // Dynamic sphere: mass=1, restitution=0.75.
    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        restitution: 0.75,
    });

    // Static ground.
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
    });

    // Wait for the sphere to settle (y ≈ 1.0 for 30 consecutive frames).
    let settleFrames = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        const y = sphere.position.y;
        if (Math.abs(y - 1.0) < 0.05) {
            settleFrames++;
            if (settleFrames > 30) {
                canvas.dataset.initMs = String(performance.now() - __initStart);
                canvas.dataset.useHighPrecisionMatrix = String(engine.useHighPrecisionMatrix);
                canvas.dataset.useFloatingOrigin = "true";
                canvas.dataset.offset = String(OFFSET);
                canvas.dataset.ready = "true";
            }
        } else {
            settleFrames = 0;
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
