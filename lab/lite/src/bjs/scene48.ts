// Babylon.js reference — Scene 48: Physics V2 centre-of-mass demo (port of #JVZAFL#1).
//
// Three tall 1×4×1 boxes drop onto a ground, each with a DIFFERENT centre of mass
// (marked by a red sphere parented to the box). After they rest, a horizontal force
// is applied to each box's geometric centre, toppling them differently. GUI/buttons
// dropped; force kicked via setTimeout; frame captured 10 physics steps after kick.

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;
const FRICTION = 0.2;
const RESTITUTION = 0.3;
const KICK_DELAY_MS = 2000;
const CAPTURE_STEPS_AFTER_KICK = 10;
const KICK_FORCE = new Vector3(0, 0, 400);

// Boxes start RESTING on the ground: box half-height 2 + ground top ≈ 0.05.
const REST_Y = 2.05;

interface BoxSpec {
    position: Vector3;
    centerOfMass: Vector3;
}

const BOXES: BoxSpec[] = [
    { position: new Vector3(0, REST_Y, 0), centerOfMass: new Vector3(0, 0, 0) },
    { position: new Vector3(4, REST_Y, 0), centerOfMass: new Vector3(0, 2, 0) },
    { position: new Vector3(8, REST_Y, 0), centerOfMass: new Vector3(0, -2, 0) },
];

function createMaterial(scene: Scene, color: Color3, alpha = 1): StandardMaterial {
    const material = new StandardMaterial("m", scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.alpha = alpha;
    return material;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const captureMode = new URLSearchParams(location.search).has("capture");
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new FreeCamera("camera", new Vector3(4, 9, -22), scene);
    camera.setTarget(new Vector3(4, 2, 2));
    camera.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;

    const dir = new DirectionalLight("dir", new Vector3(0, -1, 1), scene);
    dir.intensity = 0.2;

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40, subdivisions: 2 }, scene);
    ground.material = createMaterial(scene, new Color3(0.6, 0.6, 0.6));

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, hknp);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -10, 0), hk);

    const groundBody = new PhysicsBody(ground, PhysicsMotionType.STATIC, false, scene);
    const groundShape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(40, 0.1, 40), scene);
    groundShape.material = { friction: FRICTION, restitution: RESTITUTION };
    groundBody.shape = groundShape;
    groundBody.setMassProperties({ mass: 0 });

    const boxes: Mesh[] = [];
    BOXES.forEach((spec, i) => {
        const box = MeshBuilder.CreateBox(`box${i}`, { width: 1, height: 4, depth: 1 }, scene);
        box.position.copyFrom(spec.position);
        box.material = createMaterial(scene, new Color3(0.3, 0.5, 0.9), 0.8);

        const body = new PhysicsBody(box, PhysicsMotionType.DYNAMIC, true, scene);
        const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1, 4, 1), scene);
        shape.material = { friction: FRICTION, restitution: RESTITUTION };
        body.shape = shape;
        body.setMassProperties({ mass: 1, centerOfMass: spec.centerOfMass });

        // Red COM marker parented to the box (box scale is 1, so no distortion).
        const sphere = MeshBuilder.CreateSphere(`com${i}`, { diameter: 0.2, segments: 16 }, scene);
        sphere.material = createMaterial(scene, new Color3(1, 0, 0));
        sphere.parent = box;
        sphere.position.copyFrom(spec.centerOfMass);

        boxes.push(box);
    });

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let kickPending = false;
    let kicked = false;
    let kickFrame = 0;
    let captureQueued = false;

    // Count ACTUAL physics steps (onAfterPhysicsObservable fires once per Havok step), so the
    // kick and capture land on the same fixed 1/60 steps as the Lite scene regardless of how
    // many render frames elapse. onAfterRenderObservable is kept only for draw-call readout and
    // the one-time ready/initMs setup.
    scene.onAfterPhysicsObservable.add(() => {
        simulatedFrames++;

        if (kickPending && !kicked) {
            for (const box of boxes) {
                box.physicsBody!.applyForce(KICK_FORCE, box.position);
            }
            kicked = true;
            kickFrame = simulatedFrames;
            kickPending = false;
        }

        if (kicked && !captureQueued && simulatedFrames >= kickFrame + CAPTURE_STEPS_AFTER_KICK) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                // Freeze on the deterministic parity frame ONLY in capture mode;
                // the interactive scene keeps simulating.
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
            window.setTimeout(() => {
                kickPending = true;
            }, KICK_DELAY_MS);
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
