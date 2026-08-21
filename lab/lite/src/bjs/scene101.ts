// Scene 101: Physics V2 — Havok trigger volume (ball bounces through a trigger sphere)
//
// Port of playground https://playground.babylonjs.com/#M0C2X5#1. A dynamic sphere drops from
// y=4, falls DOWN through a static trigger sphere (TRIGGER_ENTERED), bounces off a perfectly
// elastic ground (restitution 1), and rises back UP through the trigger (TRIGGER_EXITED).

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsShapeType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

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

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    // Camera — FreeCamera at (0, 5, -10) looking at origin
    const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());

    // Hemispheric light
    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    // Dynamic sphere — diameter 2, starts at y=4
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.y = 4;

    // Ground — 6x6
    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);

    // Visual representation of the trigger volume — red, alpha-0.7 sphere of diameter 4
    // (= trigger radius 2 × 2) centred at the origin.
    const triggerVisual = MeshBuilder.CreateSphere("triggerVisual", { diameter: 4, segments: 32 }, scene);
    const triggerMaterial = new StandardMaterial("triggerMat", scene);
    triggerMaterial.diffuseColor = new Color3(1, 0, 0);
    triggerMaterial.alpha = 0.7;
    triggerVisual.material = triggerMaterial;

    // Havok physics — default gravity (matches the playground's enablePhysics(undefined, hk)).
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(undefined, hk);

    // Dynamic sphere body
    new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 1 }, scene);

    // Static, perfectly-bouncy ground (restitution 1)
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, restitution: 1 }, scene);

    // Trigger volume — a static sphere shape of radius 2 at the origin, flagged as a trigger so
    // bodies pass through it while overlap events are reported.
    const triggerShape = new PhysicsShapeSphere(new Vector3(0, 0, 0), 2, scene);
    triggerShape.isTrigger = true;
    const triggerTransform = new TransformNode("trigger", scene);
    const triggerBody = new PhysicsBody(triggerTransform, PhysicsMotionType.STATIC, false, scene);
    triggerBody.shape = triggerShape;

    // The ball enters the trigger on the way down and exits on the way up after bouncing.
    hk.onTriggerCollisionObservable.add((ev) => {
        console.log("scene101 trigger", ev.type, ":", ev.collider.transformNode.name, "-", ev.collidedAgainst.transformNode.name);
        if (ev.type === "TRIGGER_ENTERED") {
            canvas.dataset.entered = "true";
        }
        if (ev.type === "TRIGGER_EXITED") {
            canvas.dataset.exited = "true";
        }
    });

    // Render live. In parity capture mode, freeze after the requested number of
    // 60 Hz physics frames so Playwright screenshots a stable simulation frame.
    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    // Count ACTUAL physics steps (one per Havok fixed step) so the capture lands on the
    // same step as the Lite scene.
    scene.onAfterPhysicsObservable.add(() => {
        simulatedFrames++;
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                engine.stopRenderLoop();
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
