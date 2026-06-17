// Scene 48: Physics V2 — Havok center-of-mass demo (port of playground #JVZAFL#1).
//
// Three tall 1×4×1 boxes drop onto a ground, each with a DIFFERENT centre of mass
// (marked by a small red sphere). After they come to rest, a horizontal force is
// applied to each box at its geometric centre — because each COM differs, each box
// topples differently. GUI/buttons from the playground are dropped; the force is
// kicked via setTimeout and the parity frame is captured exactly 10 physics steps
// after the kick.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    applyPhysicsBodyForce,
    createBox,
    createDirectionalLight,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    onBeforeRender,
    onPhysicsAfterStep,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMassProperties,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh, PhysicsBody, Vec3 } from "babylon-lite";

const PHYSICS_FPS = 60;
const FRICTION = 0.2;
const RESTITUTION = 0.3;
const KICK_DELAY_MS = 2000;
const CAPTURE_STEPS_AFTER_KICK = 10;
const KICK_FORCE: Vec3 = { x: 0, y: 0, z: 400 };

// Boxes start RESTING on the ground: box half-height 2 + ground top ≈ 0.05.
const REST_Y = 2.05;

interface BoxSpec {
    position: Vec3;
    centerOfMass: Vec3;
}

const BOXES: BoxSpec[] = [
    { position: { x: 0, y: REST_Y, z: 0 }, centerOfMass: { x: 0, y: 0, z: 0 } },
    { position: { x: 4, y: REST_Y, z: 0 }, centerOfMass: { x: 0, y: 2, z: 0 } },
    { position: { x: 8, y: REST_Y, z: 0 }, centerOfMass: { x: 0, y: -2, z: 0 } },
];

interface BoxEntry {
    mesh: Mesh;
    body: PhysicsBody;
    comSphere: Mesh;
    com: Vec3;
}

function createMaterial(color: [number, number, number], alpha = 1) {
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.specularColor = [0.08, 0.08, 0.08];
    material.alpha = alpha;
    return material;
}

// Rotate a vector by a quaternion: v' = v + 2*w*(q×v) + 2*(q×(q×v)).
function quatRotate(qx: number, qy: number, qz: number, qw: number, v: Vec3): Vec3 {
    const tx = 2 * (qy * v.z - qz * v.y);
    const ty = 2 * (qz * v.x - qx * v.z);
    const tz = 2 * (qx * v.y - qy * v.x);
    return {
        x: v.x + qw * tx + (qy * tz - qz * ty),
        y: v.y + qw * ty + (qz * tx - qx * tz),
        z: v.z + qw * tz + (qx * ty - qy * tx),
    };
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const captureMode = new URLSearchParams(location.search).has("capture");
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;

    // Camera — framed on the three boxes (centroid ≈ x=4, y=2) and their topple.
    scene.camera = createFreeCamera({ x: 4, y: 9, z: -22 }, { x: 4, y: 2, z: 2 });

    const hemi = createHemisphericLight([0, 1, 0]);
    hemi.intensity = 0.7;
    addToScene(scene, hemi);

    const dir = createDirectionalLight([0, -1, 1], 0.2);
    addToScene(scene, dir);

    // Ground — 40×40, static box shape extents (40, 0.1, 40).
    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 2 });
    ground.material = createMaterial([0.6, 0.6, 0.6]);
    addToScene(scene, ground);

    // Physics — Havok, gravity (0, -10, 0).
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });

    const groundBody = createPhysicsBody(world, ground, PhysicsMotionType.STATIC);
    const groundShape = createPhysicsShape(world, {
        type: PhysicsShapeType.BOX,
        parameters: { center: { x: 0, y: 0, z: 0 }, extents: { x: 40, y: 0.1, z: 40 } },
    });
    setPhysicsBodyShape(world, groundBody, groundShape);
    setPhysicsShapeMaterial(world, groundShape, FRICTION, RESTITUTION);

    // Three tall boxes with distinct centres of mass.
    const entries: BoxEntry[] = BOXES.map((spec) => {
        const mesh = createBox(engine, 1);
        mesh.scaling.set(1, 4, 1);
        mesh.material = createMaterial([0.3, 0.5, 0.9], 0.8);
        mesh.position.set(spec.position.x, spec.position.y, spec.position.z);
        addToScene(scene, mesh);

        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC, true);
        const shape = createPhysicsShape(world, {
            type: PhysicsShapeType.BOX,
            parameters: { center: { x: 0, y: 0, z: 0 }, extents: { x: 1, y: 4, z: 1 } },
        });
        setPhysicsBodyShape(world, body, shape);
        setPhysicsShapeMaterial(world, shape, FRICTION, RESTITUTION);
        setPhysicsBodyMassProperties(world, body, { mass: 1, centerOfMass: spec.centerOfMass });

        // Red marker at the box's centre of mass — a separate top-level mesh so the
        // box's (1,4,1) scaling never distorts it. Tracked manually each frame.
        const comSphere = createSphere(engine, { diameter: 0.2, segments: 16 });
        comSphere.material = createMaterial([1, 0, 0]);
        comSphere.position.set(spec.position.x + spec.centerOfMass.x, spec.position.y + spec.centerOfMass.y, spec.position.z + spec.centerOfMass.z);
        addToScene(scene, comSphere);

        return { mesh, body, comSphere, com: spec.centerOfMass };
    });

    // Kick + capture state, evaluated in `onPhysicsAfterStep` — i.e. AFTER the Havok step has
    // integrated and synced the box transforms back to their nodes, but BEFORE the frame renders.
    // This exactly mirrors Babylon.js, where physics is advanced inside `scene.animate()` (pre-
    // render) and the kick/capture/marker logic runs in `onAfterRenderObservable`. Counting and
    // kicking from this point means a force applied here first integrates on the NEXT step, so
    // "kickFrame + CAPTURE_STEPS_AFTER_KICK" spans the identical number of integrated steps in both
    // engines, and the COM markers track the freshly-simulated pose with zero lag.
    let simulatedFrames = 0;
    let kickPending = false;
    let kicked = false;
    let kickFrame = 0;
    let captureQueued = false;

    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    onPhysicsAfterStep(world, () => {
        simulatedFrames++;

        if (kickPending && !kicked) {
            for (const entry of entries) {
                const p = entry.mesh.position;
                applyPhysicsBodyForce(world, entry.body, KICK_FORCE, { x: p.x, y: p.y, z: p.z });
            }
            kicked = true;
            kickFrame = simulatedFrames;
            kickPending = false;
        }

        // Track each COM marker: world = boxPos + rotate(boxRot, localCOM).
        for (const entry of entries) {
            const p = entry.mesh.position;
            const q = entry.mesh.rotationQuaternion;
            const r = quatRotate(q.x, q.y, q.z, q.w, entry.com);
            entry.comSphere.position.set(p.x + r.x, p.y + r.y, p.z + r.z);
        }

        if (kicked && !captureQueued && simulatedFrames >= kickFrame + CAPTURE_STEPS_AFTER_KICK) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                // Freeze on the deterministic parity frame ONLY in capture mode;
                // the interactive scene keeps simulating.
                if (captureMode) {
                    stopEngine(engine);
                }
            }, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);

    // Kick the horizontal force only after the boxes have come to rest.
    window.setTimeout(() => {
        kickPending = true;
    }, KICK_DELAY_MS);

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
