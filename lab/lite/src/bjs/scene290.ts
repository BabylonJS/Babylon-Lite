// Scene 290: Havok-only thin-instance port of playground #PX6E6C#25.

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsShapeBox, PhysicsShapeConvexHull, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { Scene } from "@babylonjs/core/scene";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";

const SIZE = 2;
const PADDING = 1;
const SIDE_COUNT = 10;
const CONVEX_SIDE_COUNT = 2;
const GROUND_SIZE = 200;
const CAPTURE_FPS = 60;

function readCaptureFrame(): number | null {
    const value = new URLSearchParams(window.location.search).get("captureFrame");
    if (value === null) {
        return null;
    }
    const frame = Number(value);
    return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
}

function createRandom(): () => number {
    let state = 0x290;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function addShapeInstances(scene: Scene, mesh: Mesh, shape: PhysicsShape, countPerSide: number, startY: number, random: () => number): number {
    const count = countPerSide ** 3;
    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 4);
    const matrix = Matrix.Identity();
    let index = 0;
    for (let x = 0; x < countPerSide; x++) {
        for (let y = 0; y < countPerSide; y++) {
            for (let z = 0; z < countPerSide; z++) {
                matrix.setTranslationFromFloats(
                    (x - countPerSide / 2) * (SIZE + PADDING),
                    y * (SIZE + PADDING) + SIZE / 2 + startY,
                    (z - countPerSide / 2) * (SIZE + PADDING)
                );
                matrix.copyToArray(matrices, index * 16);
                const colorOffset = index * 4;
                colors[colorOffset] = random();
                colors[colorOffset + 1] = random();
                colors[colorOffset + 2] = random();
                colors[colorOffset + 3] = 1;
                index++;
            }
        }
    }
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceSetBuffer("color", colors, 4);
    const body = new PhysicsBody(mesh, PhysicsMotionType.DYNAMIC, false, scene);
    body.disablePreStep = true;
    body.shape = shape;
    body.setMassProperties({ mass: SIZE });
    return count;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true });
    await engine.initAsync();
    const captureFrame = readCaptureFrame();
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("cam", 0, 0.8, 200, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    new HemisphericLight("default light", Vector3.Up(), scene);

    const material = new StandardMaterial("objectsMaterial", scene);
    const box = MeshBuilder.CreateBox("baseBox", { width: SIZE, height: SIZE, depth: SIZE }, scene);
    const sphere = MeshBuilder.CreateSphere("baseSphere", { diameter: SIZE }, scene);
    const convex = MeshBuilder.CreateTorusKnot("baseConvex", { radius: SIZE, tube: SIZE / 4 }, scene);
    box.material = sphere.material = convex.material = material;

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const plugin = new HavokPlugin(false, hknp);
    plugin.setTimeStep(1 / CAPTURE_FPS);
    scene.enablePhysics(new Vector3(0, -10, 0), plugin);

    const shapeMaterial = { friction: 0.2, restitution: 0.3 };
    const boxShape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(SIZE, SIZE, SIZE), scene);
    const sphereShape = new PhysicsShapeSphere(Vector3.Zero(), SIZE / 2, scene);
    const convexShape = new PhysicsShapeConvexHull(convex, scene);
    boxShape.material = sphereShape.material = convexShape.material = shapeMaterial;

    const ground = MeshBuilder.CreateGround("ground1", { width: GROUND_SIZE, height: GROUND_SIZE }, scene);
    const groundMaterial = new StandardMaterial("groundMaterial", scene);
    groundMaterial.diffuseColor = new Color3(0.3, 0.3, 0.3);
    ground.material = groundMaterial;
    const groundShape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(GROUND_SIZE, 0.001, GROUND_SIZE), scene);
    groundShape.material = shapeMaterial;
    const groundBody = new PhysicsBody(ground, PhysicsMotionType.STATIC, false, scene);
    groundBody.shape = groundShape;
    groundBody.setMassProperties({ mass: 0 });

    const random = createRandom();
    let nativeBodyCount = 1;
    nativeBodyCount += addShapeInstances(scene, box, boxShape, SIDE_COUNT, 100, random);
    nativeBodyCount += addShapeInstances(scene, sphere, sphereShape, SIDE_COUNT, 100 + SIDE_COUNT * (SIZE + PADDING) + SIZE / 2, random);
    nativeBodyCount += addShapeInstances(scene, convex, convexShape, CONVEX_SIDE_COUNT, 100 + 2 * SIDE_COUNT * (SIZE + PADDING) + SIZE / 2, random);
    canvas.dataset.nativeBodies = String(nativeBodyCount);

    let simulatedFrames = 0;
    let captureQueued = false;
    scene.onAfterPhysicsObservable.add(() => {
        simulatedFrames++;
        if (captureFrame !== null && !captureQueued && simulatedFrames >= captureFrame) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                engine.stopRenderLoop();
            }, 0);
        }
    });
    scene.onAfterRenderObservable.addOnce(() => {
        canvas.dataset.ready = "true";
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
}

void main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
