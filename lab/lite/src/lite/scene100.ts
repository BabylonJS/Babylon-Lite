// Scene 100: Physics V2 — Havok sphere drop + collision event (scene40 + registered collision)

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
    onBeforeRender,
    onPhysicsAfterStep,
    onPhysicsCollision,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyCollisionEventsEnabled,
    startEngine,
    stopEngine,
} from "babylon-lite";

const PHYSICS_FPS = 60;

function readCaptureAfterFrames(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
    }
    const value = params.get("captureAfter");
    if (value === null) {
        return null;
    }
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * PHYSICS_FPS) : null;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    // Camera — FreeCamera at (0, 5, -10) targeting origin
    scene.camera = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });

    // Hemispheric light — intensity 0.7
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    // Sphere — diameter 2, starts at y=4 (will drop via physics)
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.material = createStandardMaterial();
    sphere.position.set(0, 4, 0);
    addToScene(scene, sphere);

    // Ground — 10x10
    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    // Per-frame draw-call readout for the harness.
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    let simulatedFrames = 0;
    let captureQueued = false;

    // Havok physics — gravity (0, -9.8, 0)
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // Count ACTUAL physics steps (not render frames) so the parity capture lands on the
    // same fixed 1/60 step as the BJS reference. onPhysicsAfterStep fires exactly once per
    // Havok step (after the body→node sync, before render), mirroring BJS onAfterPhysics.
    onPhysicsAfterStep(world, () => {
        simulatedFrames++;
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
    });

    // Dynamic sphere: mass=1, restitution=0.75
    const sphereAggregate = createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        restitution: 0.75,
    });

    // Static ground
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
    });

    // Register a collision event on the falling sphere. When it hits the ground a collision
    // event fires and we log it. This is non-visual: the scene renders identically to scene40.
    setPhysicsBodyCollisionEventsEnabled(world, sphereAggregate.body, true);
    onPhysicsCollision(world, (info) => {
        // eslint-disable-next-line no-console
        console.log("scene100 collision", info.type, info.impulse);
        canvas.dataset.collided = "true";
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
