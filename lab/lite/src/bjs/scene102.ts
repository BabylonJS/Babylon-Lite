// Scene 102: Physics V2 — Havok raycast with collision filtering (port of PG #PY59V9#7, BJS reference).

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { RayHelper } from "@babylonjs/core/Debug/rayHelper";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;
const CAPTURE_DEFAULT_FRAME = 5;
const COLLIDE_WITH = 2;

const RAY_ORIGIN = new Vector3(0, 1, -2);
const RAY_DIR = new Vector3(0.1, 0, 1);
const RAY_LEN = 8;
const RAY_DEST = RAY_ORIGIN.add(RAY_DIR.scale(RAY_LEN));

function readCaptureFrame(): number {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_DEFAULT_FRAME;
    }
    return CAPTURE_DEFAULT_FRAME;
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureFrame = readCaptureFrame();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("c", -0.5, Math.PI / 3, 20, Vector3.Zero(), scene);

    new HemisphericLight("light", new Vector3(0, 1, 0), scene);

    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -10, 0), hk);

    const setMaterial = (mesh: Mesh, color: Color3): void => {
        const mat = new StandardMaterial("mat", scene);
        mat.diffuseColor = color;
        mat.specularColor = new Color3(0, 0, 0);
        mesh.material = mat;
    };

    const makeSphere = (position: Vector3, color: Color3): Mesh => {
        const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 0.2, segments: 32 }, scene);
        const mat = new StandardMaterial("sp", scene);
        mat.diffuseColor = color;
        sphere.material = mat;
        sphere.position.copyFrom(position);
        return sphere;
    };

    // Two static MESH boxes with distinct filter membership masks.
    const box1 = MeshBuilder.CreateBox("b1", { size: 2 }, scene);
    setMaterial(box1, new Color3(0.38, 0.75, 0.91));
    box1.position.set(0, 1, 1);
    const agg1 = new PhysicsAggregate(box1, PhysicsShapeType.MESH, { mass: 0 }, scene);
    agg1.shape.filterMembershipMask = 1;

    const box2 = MeshBuilder.CreateBox("b2", { size: 2 }, scene);
    setMaterial(box2, new Color3(0.38, 0.91, 0.46));
    box2.position.set(0, 1, 4);
    const agg2 = new PhysicsAggregate(box2, PhysicsShapeType.MESH, { mass: 0 }, scene);
    agg2.shape.filterMembershipMask = 2;

    // Ground.
    const ground = MeshBuilder.CreateGround("ground", { width: 10, height: 10 }, scene);
    setMaterial(ground, new Color3(0.2, 0.2, 0.2));
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // Ray visual: yellow ray + green origin sphere + red destination sphere.
    const ray = new Ray(RAY_ORIGIN, RAY_DIR, RAY_LEN);
    const rayHelper = new RayHelper(ray);
    rayHelper.show(scene, new Color3(1, 1, 0));
    makeSphere(RAY_ORIGIN, new Color3(0, 1, 0));
    makeSphere(RAY_DEST, new Color3(1, 0, 0));

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let steps = 0;
    let raycastDone = false;
    let captureQueued = false;

    scene.onAfterPhysicsObservable.add(() => {
        steps++;
        if (!raycastDone) {
            raycastDone = true;
            const result = scene.getPhysicsEngine()!.raycast(RAY_ORIGIN, RAY_DEST, { collideWith: COLLIDE_WITH });
            console.log("scene102 raycast", {
                collideWith: COLLIDE_WITH,
                hasHit: result.hasHit,
                hitPoint: result.hitPointWorld.toString(),
                hitDistance: result.hitDistance,
                triangleIndex: result.triangleIndex,
            });
            if (result.hasHit) {
                makeSphere(result.hitPointWorld, new Color3(1, 1, 0));
            }
            canvas.dataset.rayResult = JSON.stringify({
                hasHit: result.hasHit,
                hitPoint: { x: round(result.hitPointWorld.x), y: round(result.hitPointWorld.y), z: round(result.hitPointWorld.z) },
                hitDistance: round(result.hitDistance),
                triangleIndex: result.triangleIndex,
            });
        }
        if (!captureQueued && steps >= captureFrame) {
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
    // Reference the camera so it isn't tree-shaken as unused.
    void camera;
})().catch(console.error);
