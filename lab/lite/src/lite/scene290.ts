// Scene 290: Havok thin-instance stress test (playground #PX6E6C#25).

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTorusKnot,
    enableHavokThinInstancePhysics,
    getPhysicsBodyInstanceCount,
    onPhysicsAfterStep,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMass,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    setThinInstanceColors,
    setThinInstances,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, PhysicsShape, PhysicsWorld, SceneContext } from "babylon-lite";

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

function addShapeInstances(
    scene: SceneContext,
    world: PhysicsWorld,
    mesh: Mesh,
    shape: PhysicsShape,
    countPerSide: number,
    startY: number,
    random: () => number
): number {
    const count = countPerSide ** 3;
    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 4);
    let index = 0;
    for (let x = 0; x < countPerSide; x++) {
        for (let y = 0; y < countPerSide; y++) {
            for (let z = 0; z < countPerSide; z++) {
                const matrixOffset = index * 16;
                matrices[matrixOffset] = 1;
                matrices[matrixOffset + 5] = 1;
                matrices[matrixOffset + 10] = 1;
                matrices[matrixOffset + 12] = (x - countPerSide / 2) * (SIZE + PADDING);
                matrices[matrixOffset + 13] = y * (SIZE + PADDING) + SIZE / 2 + startY;
                matrices[matrixOffset + 14] = (z - countPerSide / 2) * (SIZE + PADDING);
                matrices[matrixOffset + 15] = 1;
                const colorOffset = index * 4;
                colors[colorOffset] = random();
                colors[colorOffset + 1] = random();
                colors[colorOffset + 2] = random();
                colors[colorOffset + 3] = 1;
                index++;
            }
        }
    }
    setThinInstances(mesh, matrices, count);
    setThinInstanceColors(mesh, colors);
    addToScene(scene, mesh);
    const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
    setPhysicsBodyPrestepType(body, PhysicsPrestepType.DISABLED);
    setPhysicsBodyShape(world, body, shape);
    setPhysicsBodyMass(world, body, SIZE);
    return getPhysicsBodyInstanceCount(body);
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine: EngineContext = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / CAPTURE_FPS;
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1 };
    const captureFrame = readCaptureFrame();

    const camera = createArcRotateCamera(0, 0.8, 200, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0]));

    const material = createStandardMaterial();
    const box = createBox(engine, SIZE);
    const sphere = createSphere(engine, { diameter: SIZE });
    const convex = createTorusKnot(engine, { radius: SIZE, tube: SIZE / 4 });
    box.material = sphere.material = convex.material = material;

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });
    await enableHavokThinInstancePhysics(world);
    const shapeMaterial = { friction: 0.2, restitution: 0.3 };
    const boxShape = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { extents: { x: SIZE, y: SIZE, z: SIZE } } });
    const sphereShape = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { radius: SIZE / 2 } });
    const convexShape = createPhysicsShape(world, { type: PhysicsShapeType.CONVEX_HULL, mesh: convex });
    for (const shape of [boxShape, sphereShape, convexShape]) {
        setPhysicsShapeMaterial(world, shape, shapeMaterial.friction, shapeMaterial.restitution);
    }

    const ground = createGround(engine, { width: GROUND_SIZE, height: GROUND_SIZE });
    const groundMaterial = createStandardMaterial();
    groundMaterial.diffuseColor = [0.3, 0.3, 0.3];
    ground.material = groundMaterial;
    addToScene(scene, ground);
    const groundShape = createPhysicsShape(world, {
        type: PhysicsShapeType.BOX,
        parameters: { extents: { x: GROUND_SIZE, y: 0.001, z: GROUND_SIZE } },
    });
    setPhysicsShapeMaterial(world, groundShape, shapeMaterial.friction, shapeMaterial.restitution);
    const groundBody = createPhysicsBody(world, ground, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, groundBody, groundShape);
    setPhysicsBodyMass(world, groundBody, 0);

    const random = createRandom();
    let nativeBodyCount = getPhysicsBodyInstanceCount(groundBody);
    nativeBodyCount += addShapeInstances(scene, world, box, boxShape, SIDE_COUNT, 100, random);
    nativeBodyCount += addShapeInstances(scene, world, sphere, sphereShape, SIDE_COUNT, 100 + SIDE_COUNT * (SIZE + PADDING) + SIZE / 2, random);
    nativeBodyCount += addShapeInstances(scene, world, convex, convexShape, CONVEX_SIDE_COUNT, 100 + 2 * SIDE_COUNT * (SIZE + PADDING) + SIZE / 2, random);
    canvas.dataset.nativeBodies = String(nativeBodyCount);

    let simulatedFrames = 0;
    let captureQueued = false;
    onPhysicsAfterStep(world, () => {
        simulatedFrames++;
        if (captureFrame !== null && !captureQueued && simulatedFrames >= captureFrame) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
