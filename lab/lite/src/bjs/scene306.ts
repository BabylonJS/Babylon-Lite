// Scene 40: Physics V2 — Havok sphere drop (matches playground #Z8HTUN#1)

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsMotionType, PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.pure";

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
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    // Camera — FreeCamera at (-2, 8, -16) looking at origin
    const camera = new FreeCamera("camera1", new Vector3(-2, 8, -16), scene);
    camera.setTarget(Vector3.Zero());

    // Hemispheric light
    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    // Ground — 16x16
    const ground = MeshBuilder.CreateGround("ground", { width: 16, height: 16 }, scene);

    // Havok physics
    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    // Fixed-step mode keeps the 2s parity capture deterministic across machines.
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    // Static ground body
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, friction: 0.6 }, scene);

    // cube material
    const cubeMat = new StandardMaterial("cubeMat", scene);

    // dynamic cube1 without parent
    const cube1 = MeshBuilder.CreateBox("cube1", undefined, scene);
    cube1.material = cubeMat;
    cube1.position.set(-6, 3, 0);
    new PhysicsAggregate(cube1, PhysicsShapeType.BOX, {
        mass: 1,
        friction: 0.5,
        restitution: 0.1,
    });

    // dynamic cube2 with offset parent
    const parent2 = new TransformNode("parent2", scene);
    parent2.position.set(-4, 3, 0);

    parent2.rotationQuaternion = Quaternion.FromEulerAngles(0, (20 * Math.PI) / 180, 0);
    const cube2 = MeshBuilder.CreateBox("cube2", undefined, scene);
    cube2.material = cubeMat;
    cube2.parent = parent2;
    new PhysicsAggregate(cube2, PhysicsShapeType.BOX, {
        mass: 1,
        friction: 0.5,
        restitution: 0.1,
    });

    // dynamic cube3 with simulated glTF root
    const root = new TransformNode("__root__", scene);
    root.scaling.z = -1;
    root.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI, 0);
    const cube3 = MeshBuilder.CreateBox("cube3", undefined, scene);
    cube3.position.set(2, 3, 0);
    cube3.rotationQuaternion = Quaternion.FromEulerAngles(0, (40 * Math.PI) / 180, 0);
    cube3.material = cubeMat;
    cube3.parent = root;
    new PhysicsAggregate(cube3, PhysicsShapeType.BOX, {
        mass: 1,
        friction: 0.5,
        restitution: 0.1,
    });

    // dynamic cube4 with offset parents and pre-step
    const parent4a = new TransformNode("parent4a", scene);
    const parent4b = new TransformNode("parent4", scene);
    parent4b.position.set(2, 3, 0);
    parent4b.parent = parent4a;
    const cube4 = MeshBuilder.CreateBox("cube4", undefined, scene);
    cube4.material = cubeMat;
    cube4.parent = parent4b;
    const agg4 = new PhysicsAggregate(cube4, PhysicsShapeType.BOX, {
        mass: 1,
        friction: 0.5,
        restitution: 0.1,
    });
    agg4.body.disablePreStep = false;

    // dynamic cube4 with offset parents and pre-step
    const parent5a = new TransformNode("parent5a", scene);
    const parent5b = new TransformNode("parent5b", scene);
    parent5b.position.set(4, 2, 0);
    parent5b.parent = parent5a;
    const cube5 = MeshBuilder.CreateBox("cube5", undefined, scene);
    cube5.material = cubeMat;
    cube5.parent = parent5b;
    const agg5 = new PhysicsAggregate(cube5, PhysicsShapeType.BOX, {
        mass: 1,
        friction: 0.5,
        restitution: 0.1,
    });
    agg5.body.disablePreStep = true;
    agg5.body.setMotionType(PhysicsMotionType.ANIMATED);
    agg5.body.setPrestepType(PhysicsPrestepType.ACTION);

    // physics debug viewer
    const physicsViewer = new PhysicsViewer();
    for (const mesh of scene.meshes) {
        if (mesh.physicsBody) {
            physicsViewer.showBody(mesh.physicsBody);
        }
    }

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

        if (!captureQueued) {
            // update animated parents
            parent4a.position.z = Math.sin((simulatedFrames * Math.PI) / 180);
            parent4b.rotationQuaternion = Quaternion.FromEulerAngles(0, (simulatedFrames * Math.PI) / 180, 0);

            parent5a.position.y = Math.sin((simulatedFrames * Math.PI) / 180);
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
