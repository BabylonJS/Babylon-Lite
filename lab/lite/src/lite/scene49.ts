// Scene 49: Physics V2 — Havok shape queries (merge of PG #1VT1BK#11 shapeProximity
// + #1VT1BK#12 shapeCast into ONE scene).
//
// The two playgrounds are shown side-by-side as TWO distinct, non-overlapping groups
// (stacked along Y so both frame cleanly):
//
//   • Group A (TOP, y = +GROUP_Y) — shapeProximity (#11):
//       yellow cylinder (mesh1A, query INPUT shape, no body) + blue capsule (mesh2A,
//       ANIMATED body in the broadphase). Closest-point pair drawn as:
//         ORANGE sphere = closest point ON the cylinder (query-shape local → parented to mesh1A)
//         RED    sphere = closest point ON the capsule    (world space)
//
//   • Group B (BOTTOM, y = -GROUP_Y) — shapeCast (#12):
//       yellow cylinder (mesh1B, query INPUT shape, no body) + blue capsule (mesh2B,
//       ANIMATED body in the broadphase). The cylinder is swept +X by length 5 and:
//         CYAN  tube   = the cast ray
//         GREEN sphere = the swept hit point on the capsule (world space)
//
// Interactive rotation gizmo (the GizmoManager the playgrounds had): clicking a cylinder
// attaches a 3-axis ROTATION gizmo to it (GPU-picked on pointerdown). The queries read the
// cylinder's LIVE rotationQuaternion, so rotating a cylinder updates its query in real time.
// The gizmo is INTERACTIVE-ONLY: it is created lazily on the first cylinder click, so during
// the static parity capture (nothing is clicked) NO gizmo exists or renders. The cylinders
// start at identity rotation, so the live-rotation query reads identity at capture time.
//
// The scene is otherwise static: the parity frame is captured a few physics steps in — once
// the broadphase exists and both queries report hits.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    attachControl,
    attachRotationGizmoToNode,
    createArcRotateCamera,
    createCapsule,
    createCylinder,
    createEngine,
    createGpuPicker,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsBody,
    createPhysicsShape,
    createRotationGizmo,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTube,
    createUtilityLayer,
    isGizmoDragging,
    isGizmoInteracting,
    isGizmoPickPending,
    onPhysicsAfterStep,
    PhysicsMotionType,
    PhysicsShapeType,
    pickAsync,
    registerScene,
    registerUtilityLayer,
    setPhysicsBodyPreStep,
    setPhysicsBodyShape,
    setRotationGizmoLocalCoordinates,
    shapeCast,
    shapeProximity,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh, PhysicsShape, RotationGizmo } from "babylon-lite";

const CAPTURE_STEPS = 5;

// Vertical separation between the two groups (Group A above, Group B below).
const GROUP_Y = 2.5;

// Markers are nudged toward the camera so they float just in front of the surface they
// mark (a closest/contact point lies ON a shape surface, which would z-fight with it).
// Camera (beta π/3, alpha -π/2) direction from target toward camera is (0, 0.5, -0.866) —
// independent of the target offset. The proximity markers use a small nudge; the shapeCast
// hit uses a larger nudge so distinct-coloured markers never overlap or z-fight.
const CAM_DIR = { x: 0, y: 0.5, z: -0.866 };
const PROX_NUDGE = 0.08;
const CAST_NUDGE = 0.2;

function nudged(p: { x: number; y: number; z: number }, amount: number): [number, number, number] {
    return [p.x + CAM_DIR.x * amount, p.y + CAM_DIR.y * amount, p.z + CAM_DIR.z * amount];
}

function makeMaterial(color: [number, number, number], emissive?: [number, number, number]) {
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.specularColor = [0.08, 0.08, 0.08];
    if (emissive) {
        material.emissiveColor = emissive;
    }
    return material;
}

function makeIndicator(mesh: Mesh, color: [number, number, number]): void {
    mesh.material = makeMaterial([0, 0, 0], color);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const captureMode = new URLSearchParams(location.search).has("capture");
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 14, { x: 1.2, y: 0, z: 0 });
    scene.camera = camera;
    // Orbit controls, but defer to the gizmo while it is being interacted with.
    attachControl(camera, canvas, scene, {
        shouldHandlePointerDown: () => !isGizmoInteracting(canvas),
        isExternalDragActive: () => isGizmoDragging(canvas),
        isExternalPickPending: () => isGizmoPickPending(canvas),
    });

    const hemi = createHemisphericLight([0, 1, 0]);
    hemi.intensity = 0.7;
    addToScene(scene, hemi);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp);

    // Build a group: yellow cylinder (query INPUT shape, no body) + blue capsule (ANIMATED
    // body so it lives in the broadphase). `yOffset` separates the two groups vertically.
    function buildGroup(yOffset: number): { cylinder: Mesh; cylinderShape: PhysicsShape; capsulePos: { x: number; y: number; z: number } } {
        const cylinder = createCylinder(engine, { height: 2, diameter: 1 });
        cylinder.material = makeMaterial([0.85, 0.8, 0.1]);
        cylinder.position.set(-1, yOffset, 0);
        addToScene(scene, cylinder);
        const cylinderShape = createPhysicsShape(world, {
            type: PhysicsShapeType.CYLINDER,
            parameters: { pointA: { x: 0, y: -1, z: 0 }, pointB: { x: 0, y: 1, z: 0 }, radius: 0.5 },
        });

        const capsule = createCapsule(engine, { height: 2, radius: 0.5 });
        capsule.material = makeMaterial([0.2, 0.4, 0.9]);
        capsule.position.set(1, yOffset, 0);
        addToScene(scene, capsule);
        const body = createPhysicsBody(world, capsule, PhysicsMotionType.ANIMATED);
        const capsuleShape = createPhysicsShape(world, {
            type: PhysicsShapeType.CAPSULE,
            parameters: { pointA: { x: 0, y: -0.5, z: 0 }, pointB: { x: 0, y: 0.5, z: 0 }, radius: 0.5 },
        });
        setPhysicsBodyShape(world, body, capsuleShape);
        setPhysicsBodyPreStep(body, true);

        return { cylinder, cylinderShape, capsulePos: { x: 1, y: yOffset, z: 0 } };
    }

    // ── Group A — shapeProximity (top) ───────────────────────────────────────
    const groupA = buildGroup(GROUP_Y);
    const proxOnCylinder = createSphere(engine, { diameter: 0.15, segments: 16 });
    makeIndicator(proxOnCylinder, [1, 0.5, 0]); // orange — closest point on cylinder (LOCAL → parented)
    proxOnCylinder.parent = groupA.cylinder;
    groupA.cylinder.children.push(proxOnCylinder);
    addToScene(scene, proxOnCylinder);
    const proxOnCapsule = createSphere(engine, { diameter: 0.15, segments: 16 });
    makeIndicator(proxOnCapsule, [1, 0, 0]); // red — closest point on capsule (WORLD)
    addToScene(scene, proxOnCapsule);

    // ── Group B — shapeCast (bottom) ─────────────────────────────────────────
    const groupB = buildGroup(-GROUP_Y);
    const castStart = { x: -1, y: -GROUP_Y, z: 0 };
    const castEnd = { x: 4, y: -GROUP_Y, z: 0 };
    const rayTube = createTube(engine, { path: [castStart, castEnd], radius: 0.02, tessellation: 8 });
    rayTube.material = makeMaterial([0, 0, 0], [0.2, 0.8, 1]); // cyan — cast ray
    addToScene(scene, rayTube);
    const castHit = createSphere(engine, { diameter: 0.15, segments: 16 });
    makeIndicator(castHit, [0, 1, 0]); // green — swept hit point on capsule (WORLD)
    addToScene(scene, castHit);

    let steps = 0;
    let captureQueued = false;
    onPhysicsAfterStep(world, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        steps++;

        // Group A — shapeProximity: closest-point pair, reading the cylinder's LIVE rotation.
        const c1 = groupA.cylinder;
        const prox = shapeProximity(world, {
            shape: groupA.cylinderShape,
            position: { x: c1.position.x, y: c1.position.y, z: c1.position.z },
            rotation: { x: c1.rotationQuaternion.x, y: c1.rotationQuaternion.y, z: c1.rotationQuaternion.z, w: c1.rotationQuaternion.w },
            maxDistance: 10,
        });
        if (prox.hasHit) {
            proxOnCylinder.position.set(...nudged(prox.inputHitPoint, PROX_NUDGE));
            proxOnCapsule.position.set(...nudged(prox.hitPoint, PROX_NUDGE));
        }

        // Group B — shapeCast: sweep the cylinder along +X, reading its LIVE rotation.
        const c2 = groupB.cylinder;
        const cast = shapeCast(world, {
            shape: groupB.cylinderShape,
            rotation: { x: c2.rotationQuaternion.x, y: c2.rotationQuaternion.y, z: c2.rotationQuaternion.z, w: c2.rotationQuaternion.w },
            startPosition: castStart,
            endPosition: castEnd,
        });
        if (cast.hasHit) {
            castHit.position.set(...nudged(cast.hitPoint, CAST_NUDGE));
        }

        if (!captureQueued && steps >= CAPTURE_STEPS && prox.hasHit && cast.hasHit) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                // Freeze on the deterministic parity frame ONLY in capture mode.
                if (captureMode) {
                    stopEngine(engine);
                }
            }, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);

    // Interactive rotation gizmo — created lazily on first cylinder click so the static
    // capture frame contains no gizmo. Both cylinders are attachable.
    const utilityLayer = createUtilityLayer(engine, scene);
    await registerUtilityLayer(utilityLayer);
    const picker = createGpuPicker(scene);
    let rotationGizmo: RotationGizmo | null = null;
    const cylinders: Mesh[] = [groupA.cylinder, groupB.cylinder];
    canvas.addEventListener("pointerdown", async (e) => {
        const info = await pickAsync(picker, e.offsetX, e.offsetY);
        const picked = info.hit ? info.pickedMesh : null;
        const target = picked && cylinders.includes(picked as Mesh) ? (picked as Mesh) : null;
        if (!rotationGizmo) {
            if (!target) {
                return;
            }
            rotationGizmo = createRotationGizmo(engine, utilityLayer);
            setRotationGizmoLocalCoordinates(rotationGizmo, true);
        }
        // Attach to the clicked cylinder (or detach when clicking elsewhere).
        attachRotationGizmoToNode(rotationGizmo, target);
    });

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
