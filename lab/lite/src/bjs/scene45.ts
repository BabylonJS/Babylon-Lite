// Babylon.js reference — Scene 45: Physics collision filtering (playground #H4UR4Z#1)

import HavokPhysics from "@babylonjs/havok";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;
const FILTER_GROUP_SPHERE = 1;
const FILTER_GROUP_GROUND = 2;
const FILTER_GROUP_BOX = 4;

function readCaptureAfterFrames(): number | null {
    const value = new URLSearchParams(window.location.search).get("captureAfter");
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
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new FreeCamera("camera1", new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const sphereMat = new StandardMaterial("sphereMat", scene);
    sphereMat.diffuseColor = new Color3(1, 1, 1);
    sphereMat.specularColor = new Color3(0.08, 0.08, 0.08);

    const sphere1 = MeshBuilder.CreateSphere("sphere1", { diameter: 2, segments: 32 }, scene);
    sphere1.position.set(1.5, 5, 0);
    sphere1.material = sphereMat;

    const sphere2 = MeshBuilder.CreateSphere("sphere2", { diameter: 2, segments: 32 }, scene);
    sphere2.position.set(-1.5, 4, 0);
    sphere2.material = sphereMat;

    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.5, 0.5, 0.5);
    ground.material = groundMat;

    const box = MeshBuilder.CreateBox("box", { width: 8, height: 2, depth: 2 }, scene);
    const redMaterial = new StandardMaterial("box", scene);
    redMaterial.diffuseColor.set(1, 0, 0);
    redMaterial.specularColor = new Color3(0.08, 0.08, 0.08);
    box.material = redMaterial;

    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    scene.enablePhysics(new Vector3(0, -1, 0), hk);

    const sphere1Aggregate = new PhysicsAggregate(sphere1, PhysicsShapeType.SPHERE, { mass: 1 }, scene);
    const sphere2Aggregate = new PhysicsAggregate(sphere2, PhysicsShapeType.SPHERE, { mass: 1 }, scene);
    const groundAggregate = new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);
    const boxAggregate = new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0 }, scene);

    sphere1Aggregate.body.applyForce(sphere1Aggregate.body.getObjectCenterWorld(), new Vector3(0, 1, 5));

    sphere1Aggregate.shape.filterMembershipMask = FILTER_GROUP_SPHERE;
    sphere2Aggregate.shape.filterMembershipMask = FILTER_GROUP_SPHERE;
    groundAggregate.shape.filterMembershipMask = FILTER_GROUP_GROUND;
    boxAggregate.shape.filterMembershipMask = FILTER_GROUP_BOX;

    sphere1Aggregate.shape.filterCollideMask = FILTER_GROUP_GROUND | FILTER_GROUP_BOX;
    sphere2Aggregate.shape.filterCollideMask = FILTER_GROUP_GROUND;

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        const now = performance.now();
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(now - __initStart);
            canvas.dataset.ready = "true";
        } else {
            simulatedFrames++;
        }
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => {
                engine.stopRenderLoop();
            }, 0);
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
