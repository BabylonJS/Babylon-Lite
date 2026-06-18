// Scene 106: Physics V2 — Havok motion-types × prestep-types grid (port of PG #E9R16H#1).
//
// A 2×3 grid of cells: rows are prestep type [TELEPORT, ACTION], columns are motion type
// [STATIC, ANIMATED, DYNAMIC]. Each cell is a 10×1×10 box (the "platform", whose motion + prestep
// type are set per cell) with a falling cylinder (diameter 2, height 2) resting 0.5 above it. Every
// box node is nudged each physics step (x += cos(t)*0.03; z += sin(t)*0.03; y = 0), and the box's
// prestep type governs how that node motion is fed to Havok: TELEPORT snaps the body to the node,
// ACTION sets a velocity toward it (dragging the resting cylinder along via friction).
//
// Text labels from the playground are intentionally omitted (no DynamicTexture work).
//
// Determinism: the animation is advanced count-based from the fixed 1/60 physics step (mirroring the
// playground's deltaTime/300 increment at 60 fps) so Lite and Babylon.js box nodes stay byte-identical.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createCylinder,
    createBox,
    createEngine,
    createFreeCamera,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    onPhysicsAfterStep,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMotionType,
    setPhysicsBodyPreStep,
    setPhysicsBodyPrestepType,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const PHYSICS_FPS = 60;

// Deterministic 6-colour palette, indexed by prestep*3 + motion. Hardcoded (NOT Color3.Random,
// which breaks parity) and identical to the BJS reference scene.
const PALETTE: [number, number, number][] = [
    [0.85, 0.25, 0.25], // TELEPORT · STATIC
    [0.25, 0.75, 0.3], // TELEPORT · ANIMATED
    [0.25, 0.45, 0.85], // TELEPORT · DYNAMIC
    [0.9, 0.8, 0.25], // ACTION · STATIC
    [0.8, 0.3, 0.8], // ACTION · ANIMATED
    [0.25, 0.8, 0.8], // ACTION · DYNAMIC
];

// Per-step animation increment: mirrors the playground's `t += engine.getDeltaTime()/300` at 60 fps.
const T_PER_STEP = 1000 / PHYSICS_FPS / 300;

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

    // Camera — FreeCamera at (-24, 30, 5) targeting (12, 0, 5)
    scene.camera = createFreeCamera({ x: -24, y: 30, z: 5 }, { x: 12, y: 0, z: 5 });

    // Hemispheric light — intensity 0.7
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    let simulatedFrames = 0;
    let captureQueued = false;

    // Havok physics — gravity (0, -9.8, 0)
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    const motions = [PhysicsMotionType.STATIC, PhysicsMotionType.ANIMATED, PhysicsMotionType.DYNAMIC];
    const presteps = [PhysicsPrestepType.TELEPORT, PhysicsPrestepType.ACTION];

    const boxes: Mesh[] = [];

    for (let prestep = 0; prestep < 2; prestep++) {
        for (let motion = 0; motion < 3; motion++) {
            // Cylinder (diameter 2, height 2) resting 0.5 above the box.
            const cylinder = createCylinder(engine, { diameter: 2, height: 2 });
            cylinder.position.set(motion * 12, 2, prestep * 12);
            const cylMat = createStandardMaterial();
            cylMat.diffuseColor = PALETTE[prestep * 3 + motion]!;
            cylinder.material = cylMat;
            addToScene(scene, cylinder);
            createPhysicsAggregate(world, cylinder, PhysicsShapeType.CYLINDER, {
                mass: 1,
                restitution: 0.1,
                friction: 1,
                radius: 1,
                pointA: { x: 0, y: -1, z: 0 },
                pointB: { x: 0, y: 1, z: 0 },
            });

            // Box (width 10, height 1, depth 10) — the per-cell platform.
            const box = createBox(engine, 1);
            box.scaling.set(10, 1, 10);
            box.position.set(motion * 12, 0, prestep * 12);
            box.material = createStandardMaterial();
            addToScene(scene, box);
            const boxAggregate = createPhysicsAggregate(world, box, PhysicsShapeType.BOX, {
                mass: motion,
                friction: 1,
                extents: { x: 10, y: 1, z: 10 },
            });
            setPhysicsBodyMotionType(world, boxAggregate.body, motions[motion]!);
            setPhysicsBodyPrestepType(boxAggregate.body, presteps[prestep]!);
            // The box node is moved every step; flag it so the (DYNAMIC) box is pre-step synced like
            // the ANIMATED/STATIC ones (BJS syncs every non-DISABLED body pre-step).
            setPhysicsBodyPreStep(boxAggregate.body, true);
            boxes.push(box);
        }
    }

    // Advance the box-nudge animation count-based from the fixed step (NOT wall-clock) so Lite and
    // BJS match exactly. Runs after the step's body→node sync (so DYNAMIC boxes pick up their
    // freshly-integrated pose) and is consumed by the NEXT step's prestep sync — mirroring the BJS
    // onAfterPhysicsObservable ordering.
    let t = 0;
    onPhysicsAfterStep(world, () => {
        const c = Math.cos(t) * 0.03;
        const s = Math.sin(t) * 0.03;
        for (let i = 0; i < boxes.length; i++) {
            const p = boxes[i]!.position;
            p.set(p.x + c, 0, p.z + s);
        }
        t += T_PER_STEP;

        simulatedFrames++;
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
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
