// Scene 101: Physics V2 — Havok trigger volume (ball bounces through a trigger sphere)
//
// Port of playground https://playground.babylonjs.com/#M0C2X5#1. A dynamic sphere drops from
// y=4, falls DOWN through a static trigger sphere (TRIGGER_ENTERED), bounces off a perfectly
// elastic ground (restitution 1), and rises back UP through the trigger (TRIGGER_EXITED). The
// trigger volume is visualised by a red, alpha-0.7 sphere at the origin.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTransformNode,
    onBeforeRender,
    onPhysicsAfterStep,
    onPhysicsTrigger,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyShape,
    setPhysicsShapeIsTrigger,
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

    // Dynamic sphere — diameter 2, starts at y=4 (will drop via physics)
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.material = createStandardMaterial();
    sphere.position.set(0, 4, 0);
    addToScene(scene, sphere);

    // Ground — 6x6
    const ground = createGround(engine, { width: 6, height: 6 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    // Visual representation of the trigger volume — red, alpha-0.7 sphere of diameter 4
    // (= trigger radius 2 × 2) centred at the origin.
    const triggerVisual = createSphere(engine, { diameter: 4, segments: 32 });
    const triggerMaterial = createStandardMaterial();
    triggerMaterial.diffuseColor = [1, 0, 0];
    triggerMaterial.alpha = 0.7;
    triggerVisual.material = triggerMaterial;
    addToScene(scene, triggerVisual);

    // Per-frame draw-call readout for the harness.
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    let simulatedFrames = 0;
    let captureQueued = false;

    // Havok physics — default gravity (matches the playground's enablePhysics(undefined, hk)).
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp);

    // Count ACTUAL physics steps (not render frames) so the parity capture lands on the same
    // fixed 1/60 step as the BJS reference.
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

    // Dynamic sphere: mass=1
    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, { mass: 1 });

    // Static, perfectly-bouncy ground (restitution 1)
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0, restitution: 1 });

    // Trigger volume — a static sphere shape of radius 2 at the origin, flagged as a trigger so
    // bodies pass through it while overlap events are reported.
    const triggerShape = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { center: { x: 0, y: 0, z: 0 }, radius: 2 } });
    setPhysicsShapeIsTrigger(world, triggerShape, true);
    const triggerNode = createTransformNode("trigger", 0, 0, 0);
    const triggerBody = createPhysicsBody(world, triggerNode, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, triggerBody, triggerShape);

    // The ball enters the trigger on the way down and exits on the way up after bouncing.
    onPhysicsTrigger(world, (info) => {
        // eslint-disable-next-line no-console
        console.log("scene101 trigger", info.type);
        if (info.type === "ENTERED") {
            canvas.dataset.entered = "true";
        }
        if (info.type === "EXITED") {
            canvas.dataset.exited = "true";
        }
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
