// Scene 100: Physics V2 — Havok sphere drop + collision event (scene40 + registered collision)

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
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

    // Sphere — diameter 2, starts at y=4
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 32 }, scene);
    sphere.position.y = 4;

    // Ground — 10x10
    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);

    // Havok physics
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    // Fixed-step mode keeps the 2s parity capture deterministic across machines.
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    // Dynamic sphere body
    const sphereAggregate = new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.75 }, scene);

    // Static ground body
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // Register a collision event on the falling sphere. When it hits the ground a collision
    // event fires and we log it. This is non-visual: the scene renders identically to scene40.
    sphereAggregate.body.setCollisionCallbackEnabled(true);
    sphereAggregate.body.getCollisionObservable().add((ev) => {
        console.log("scene100 collision", ev.type, ev.impulse);
        canvas.dataset.collided = "true";
    });

    // Render live. In parity capture mode, freeze after the requested number of
    // 60 Hz physics frames so Playwright screenshots a stable 2s simulation frame.
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
    // same step as the Lite scene. onAfterPhysicsObservable fires once per physics step.
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
