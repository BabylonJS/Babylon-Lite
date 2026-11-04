// Babylon.js reference — Scene 103: thin-instanced wall + raycast instance picking (port of PG #I6AR8X).
//
// A PhysicsAggregate(baseBlock, BOX, { mass: 0 }) on a thin-instanced mesh auto-creates one body per
// instance; the raycast result's `bodyIndex` IS the thin-instance index. A fixed set of deterministic
// rays is fired from a camera-relative origin into the wall; for each ray we record hasHit + bodyIndex.
// See the Lite scene for the full deviation notes (static mass-0 blocks, seeded colors, 180 instances).

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";

const PHYSICS_FPS = 60;
const CAPTURE_DEFAULT_FRAME = 5;

const WALL_W = 10;
const WALL_H = 6;
const WALL_D = 3;
const BLOCK_SIZE = 2;
const TOTAL = WALL_W * WALL_H * WALL_D;

const CAM_ALPHA = Math.PI / 2;
const CAM_BETA = Math.PI / 2.4;
const CAM_RADIUS = 38;
const CAM_TARGET = new Vector3(-1, 5, -1);

const RAY_TARGETS: ReadonlyArray<readonly [number, number, number]> = [
    [5, 3, 2],
    [2, 1, 2],
    [8, 5, 2],
    [0, 0, 2],
    [9, 2, 2],
    [4, 4, 2],
];

interface RayHit {
    hasHit: boolean;
    instance: number;
    point: { x: number; y: number; z: number };
}

function readCaptureFrame(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_DEFAULT_FRAME;
    }
    return null;
}

function rand(seed: { value: number }): number {
    seed.value = (seed.value * 1664525 + 1013904223) >>> 0;
    return seed.value / 0x100000000;
}

function instancePos(i: number, j: number, k: number): Vector3 {
    return new Vector3((i - WALL_W / 2) * BLOCK_SIZE, j * BLOCK_SIZE + BLOCK_SIZE / 2, (k - WALL_D / 2) * BLOCK_SIZE);
}

function arcCameraPosition(): Vector3 {
    return new Vector3(
        CAM_TARGET.x + CAM_RADIUS * Math.cos(CAM_ALPHA) * Math.sin(CAM_BETA),
        CAM_TARGET.y + CAM_RADIUS * Math.cos(CAM_BETA),
        CAM_TARGET.z + CAM_RADIUS * Math.sin(CAM_ALPHA) * Math.sin(CAM_BETA)
    );
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
    const autoTest = captureFrame !== null;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("cam", CAM_ALPHA, CAM_BETA, CAM_RADIUS, CAM_TARGET, scene);
    if (!autoTest) {
        camera.attachControl(canvas, true);
    }

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const havokInstance = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, havokInstance);
    hk.setTimeStep(1 / PHYSICS_FPS);
    scene.enablePhysics(new Vector3(0, -9.81, 0), hk);
    const physEngine = scene.getPhysicsEngine()!;

    // Ground.
    const ground = MeshBuilder.CreateGround("ground", { width: WALL_W * BLOCK_SIZE * 4, height: WALL_D * BLOCK_SIZE * 6 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.3, 0.3, 0.3);
    groundMat.specularColor = new Color3(0, 0, 0);
    ground.material = groundMat;
    ground.isPickable = false;
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // Thin-instanced wall.
    const baseBlock = MeshBuilder.CreateCylinder("baseBlock", { diameter: BLOCK_SIZE, height: BLOCK_SIZE, subdivisions: 10, tessellation: 48 }, scene);
    const baseMat = new StandardMaterial("baseMat", scene);
    baseMat.specularColor = new Color3(0, 0, 0);
    baseBlock.material = baseMat;

    const matrixBuffer = new Float32Array(TOTAL * 16);
    const colorBuffer = new Float32Array(TOTAL * 4);
    const matrix = Matrix.Identity();
    const seed = { value: 0x10_3a_5c };
    for (let i = 0; i < WALL_W; i++) {
        for (let j = 0; j < WALL_H; j++) {
            for (let k = 0; k < WALL_D; k++) {
                const index = i + j * WALL_W + k * WALL_W * WALL_H;
                const p = instancePos(i, j, k);
                matrix.setTranslationFromFloats(p.x, p.y, p.z);
                matrix.copyToArray(matrixBuffer, index * 16);
                colorBuffer[index * 4] = rand(seed);
                colorBuffer[index * 4 + 1] = rand(seed);
                colorBuffer[index * 4 + 2] = rand(seed);
                colorBuffer[index * 4 + 3] = 1;
            }
        }
    }
    baseBlock.thinInstanceSetBuffer("matrix", matrixBuffer, 16);
    baseBlock.thinInstanceSetBuffer("color", colorBuffer, 4);

    // Static (mass 0) aggregate: one body per thin instance, bodyIndex = instance index.
    new PhysicsAggregate(baseBlock, PhysicsShapeType.BOX, { mass: 0, restitution: 0 }, scene);

    // Green indicator sphere placed at a raycast hit point.
    const indicator = MeshBuilder.CreateSphere("indicator", { diameter: 2, segments: 24 }, scene);
    const indicatorMat = new StandardMaterial("indicatorMat", scene);
    indicatorMat.diffuseColor = new Color3(0, 1, 0);
    indicatorMat.emissiveColor = new Color3(0, 1, 0);
    indicatorMat.specularColor = new Color3(0, 0, 0);
    indicatorMat.alpha = 0.7;
    indicator.material = indicatorMat;
    indicator.isPickable = false;
    indicator.isVisible = false;

    const camOrigin = arcCameraPosition();

    const castInto = (target: Vector3): RayHit => {
        const result = physEngine.raycast(camOrigin, target);
        const hp = result.hitPointWorld;
        return {
            hasHit: result.hasHit,
            instance: result.hasHit ? (result.bodyIndex ?? -1) : -1,
            point: { x: round(hp.x), y: round(hp.y), z: round(hp.z) },
        };
    };

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    if (autoTest) {
        let steps = 0;
        let raysDone = false;
        let captureQueued = false;
        scene.onAfterPhysicsObservable.add(() => {
            steps++;
            if (!raysDone) {
                raysDone = true;
                const hits: RayHit[] = [];
                for (const [i, j, k] of RAY_TARGETS) {
                    hits.push(castInto(instancePos(i, j, k)));
                }
                const last = hits[hits.length - 1]!;
                if (last.hasHit) {
                    indicator.position.set(last.point.x, last.point.y, last.point.z);
                    indicator.isVisible = true;
                }
                canvas.dataset.rayHits = JSON.stringify(hits);
                console.log("scene103 rayHits", hits);
            }
            if (!captureQueued && steps >= captureFrame!) {
                captureQueued = true;
                window.setTimeout(() => {
                    canvas.dataset.captureReady = "true";
                    engine.stopRenderLoop();
                }, 0);
            }
        });
    } else {
        scene.onPointerDown = () => {
            const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, null, camera);
            const dest = camOrigin.add(ray.direction.scale(1000));
            const result = physEngine.raycast(camOrigin, dest);
            if (result.hasHit) {
                indicator.position.copyFrom(result.hitPointWorld);
                indicator.isVisible = true;
            }
        };
    }

    let ready = false;
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
    window.addEventListener("resize", () => engine.resize());
})().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
