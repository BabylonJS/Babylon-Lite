// Babylon.js reference — Scene 49: Physics V2 shape queries (merge of PG #1VT1BK#11
// shapeProximity + #1VT1BK#12 shapeCast into ONE scene).
//
// The two playgrounds are shown as TWO distinct, non-overlapping groups, stacked along Y:
//   • Group A (TOP)    — shapeProximity: yellow cylinder (query INPUT shape, no body) +
//       blue capsule (ANIMATED body). Orange sphere = closest point on cylinder (parented),
//       red sphere = closest point on capsule (world).
//   • Group B (BOTTOM) — shapeCast: yellow cylinder swept +X by length 5 + blue capsule
//       (ANIMATED body). Cyan ray tube + green sphere (swept hit on capsule, world).
//
// A GizmoManager (rotationGizmoEnabled) makes BOTH cylinders attachable: clicking a cylinder
// attaches a 3-axis rotation gizmo to it, and the queries read the cylinder's LIVE rotation
// quaternion so rotating it updates the query in real time. Interaction is pointer-driven, so
// the static parity frame (nothing clicked) shows no gizmo. The frame is captured a few
// physics steps in, once the broadphase exists and both queries report hits.

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GizmoManager } from "@babylonjs/core/Gizmos/gizmoManager";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { ProximityCastResult } from "@babylonjs/core/Physics/proximityCastResult";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShape, PhysicsShapeCapsule, PhysicsShapeCylinder } from "@babylonjs/core/Physics/v2/physicsShape";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const CAPTURE_STEPS = 5;

// Vertical separation between the two groups (Group A above, Group B below).
const GROUP_Y = 2.5;

// Markers are nudged toward the camera so they float just in front of the surface they mark.
const CAM_DIR = new Vector3(0, 0.5, -0.866);
const PROX_NUDGE = 0.08;
const CAST_NUDGE = 0.2;

function nudged(p: Vector3, amount: number): Vector3 {
    return p.add(CAM_DIR.scale(amount));
}

function makeMaterial(scene: Scene, color: Color3, emissive?: Color3): StandardMaterial {
    const material = new StandardMaterial("m", scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    if (emissive) {
        material.emissiveColor = emissive;
    }
    return material;
}

function makeIndicator(mesh: Mesh, scene: Scene, color: Color3): void {
    mesh.material = makeMaterial(scene, new Color3(0, 0, 0), color);
}

interface Group {
    cylinder: Mesh;
    cylinderShape: PhysicsShape;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const captureMode = new URLSearchParams(location.search).has("capture");
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 14, new Vector3(1.2, 0, 0), scene);
    camera.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, hknp);
    scene.enablePhysics(new Vector3(0, -9.81, 0), hk);

    // Build a group: yellow cylinder (query INPUT shape, no body) + blue capsule (ANIMATED body).
    function buildGroup(yOffset: number): Group {
        const cylinder = MeshBuilder.CreateCylinder("cylinder", { height: 2, diameter: 1 }, scene);
        cylinder.material = makeMaterial(scene, new Color3(0.85, 0.8, 0.1));
        cylinder.position.set(-1, yOffset, 0);
        cylinder.rotationQuaternion = Quaternion.Identity();
        const cylinderShape = new PhysicsShapeCylinder(new Vector3(0, -1, 0), new Vector3(0, 1, 0), 0.5, scene);

        const capsule = MeshBuilder.CreateCapsule("capsule", { height: 2, radius: 0.5 }, scene);
        capsule.material = makeMaterial(scene, new Color3(0.2, 0.4, 0.9));
        capsule.position.set(1, yOffset, 0);
        const body = new PhysicsBody(capsule, PhysicsMotionType.ANIMATED, false, scene);
        body.shape = new PhysicsShapeCapsule(new Vector3(0, -0.5, 0), new Vector3(0, 0.5, 0), 0.5, scene);
        body.disablePreStep = false;

        return { cylinder, cylinderShape };
    }

    // ── Group A — shapeProximity (top) ───────────────────────────────────────
    const groupA = buildGroup(GROUP_Y);
    const proxOnCylinder = MeshBuilder.CreateSphere("proxOnCylinder", { diameter: 0.15, segments: 16 }, scene);
    makeIndicator(proxOnCylinder, scene, new Color3(1, 0.5, 0)); // orange
    proxOnCylinder.parent = groupA.cylinder;
    const proxOnCapsule = MeshBuilder.CreateSphere("proxOnCapsule", { diameter: 0.15, segments: 16 }, scene);
    makeIndicator(proxOnCapsule, scene, new Color3(1, 0, 0)); // red

    // ── Group B — shapeCast (bottom) ─────────────────────────────────────────
    const groupB = buildGroup(-GROUP_Y);
    const castStart = new Vector3(-1, -GROUP_Y, 0);
    const castEnd = new Vector3(4, -GROUP_Y, 0);
    const rayTube = MeshBuilder.CreateTube("rayTube", { path: [castStart, castEnd], radius: 0.02, tessellation: 8 }, scene);
    rayTube.material = makeMaterial(scene, new Color3(0, 0, 0), new Color3(0.2, 0.8, 1)); // cyan
    const castHit = MeshBuilder.CreateSphere("castHit", { diameter: 0.15, segments: 16 }, scene);
    makeIndicator(castHit, scene, new Color3(0, 1, 0)); // green

    // Interactive rotation gizmo (the GizmoManager the playgrounds had). Both cylinders are
    // attachable; clicking one attaches a 3-axis rotation gizmo. Nothing is shown until a click.
    const gizmoManager = new GizmoManager(scene);
    gizmoManager.rotationGizmoEnabled = true;
    gizmoManager.attachableMeshes = [groupA.cylinder, groupB.cylinder];

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let steps = 0;
    let captureQueued = false;

    // Count ACTUAL physics steps (onAfterPhysicsObservable fires once per Havok step) and run the
    // queries + capture there, matching the Lite scene's onPhysicsAfterStep. onAfterRenderObservable
    // is kept only for draw-call readout and the one-time ready/initMs setup.
    scene.onAfterPhysicsObservable.add(() => {
        steps++;

        // Group A — shapeProximity: closest-point pair, reading the cylinder's LIVE rotation.
        const shapeLocalResult = new ProximityCastResult();
        const hitWorldResult = new ProximityCastResult();
        hk.shapeProximity({ shape: groupA.cylinderShape, position: groupA.cylinder.absolutePosition, rotation: groupA.cylinder.absoluteRotationQuaternion, maxDistance: 10, shouldHitTriggers: false }, shapeLocalResult, hitWorldResult);
        if (shapeLocalResult.hasHit) {
            proxOnCylinder.position.copyFrom(nudged(shapeLocalResult.hitPoint, PROX_NUDGE));
            proxOnCapsule.position.copyFrom(nudged(hitWorldResult.hitPoint, PROX_NUDGE));
        }

        // Group B — shapeCast: sweep the cylinder along +X, reading its LIVE rotation.
        const castLocalResult = new ShapeCastResult();
        const castWorldResult = new ShapeCastResult();
        hk.shapeCast({ shape: groupB.cylinderShape, rotation: groupB.cylinder.rotationQuaternion!, startPosition: castStart, endPosition: castEnd, shouldHitTriggers: false }, castLocalResult, castWorldResult);
        if (castWorldResult.hasHit) {
            castHit.position.copyFrom(nudged(castWorldResult.hitPoint, CAST_NUDGE));
        }

        if (!captureQueued && steps >= CAPTURE_STEPS && shapeLocalResult.hasHit && castWorldResult.hasHit) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                if (captureMode) {
                    engine.stopRenderLoop();
                }
            }, 0);
        }
    });

    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(performance.now() - __initStart);
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
