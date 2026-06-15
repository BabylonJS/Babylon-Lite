// Scene 46: Physics constraints — port of playground #7DMWP8#693 without text labels.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsConstraint,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    onBeforeRender,
    PhysicsConstraintAxis,
    PhysicsConstraintType,
    PhysicsShapeType,
    registerScene,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh, PhysicsWorld } from "babylon-lite";

const PHYSICS_FPS = 60;
let curX = -8;

function readCaptureAfterFrames(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : null;
    }
    return null;
}

function colorFor(index: number): [number, number, number] {
    return [((index * 83 + 37) & 255) / 255, ((index * 149 + 91) & 255) / 255, ((index * 211 + 53) & 255) / 255];
}

function makeMaterial(color: [number, number, number]) {
    const mat = createStandardMaterial();
    mat.diffuseColor = color;
    mat.specularColor = [0.08, 0.08, 0.08];
    return mat;
}

function addBox(
    scene: ReturnType<typeof createSceneContext>,
    engine: ReturnType<typeof createEngine> extends Promise<infer T> ? T : never,
    name: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: [number, number, number]
): Mesh {
    const mesh = createBox(engine, 1);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scaling.set(sx, sy, sz);
    mesh.material = makeMaterial(color);
    addToScene(scene, mesh);
    return mesh;
}

function addAggregate(world: PhysicsWorld, mesh: Mesh, mass: number): ReturnType<typeof createPhysicsAggregate> {
    return createPhysicsAggregate(world, mesh, PhysicsShapeType.BOX, { mass, restitution: 1, extents: { x: mesh.scaling.x, y: mesh.scaling.y, z: mesh.scaling.z } });
}

function ballAndSocket(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld): void {
    const col = colorFor(0);
    const box1 = addBox(scene, engine, "ballAndSocketBox1", curX, 1, 0, 1, 0.2, 1, col);
    const box2 = addBox(scene, engine, "ballAndSocketBox2", curX, 1, -1, 1, 0.2, 1, col);
    const agg1 = addAggregate(world, box1, 0);
    const agg2 = addAggregate(world, box2, 1);
    createPhysicsConstraint(world, agg1.body, agg2.body, PhysicsConstraintType.BALL_AND_SOCKET, {
        pivotA: { x: -0.5, y: 0, z: -0.5 },
        pivotB: { x: -0.5, y: 0, z: 0.5 },
        axisA: { x: 0, y: 1, z: 0 },
        axisB: { x: 0, y: 1, z: 0 },
    });
    curX += 2;
}

function distance(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld): void {
    const col = colorFor(1);
    const sphere = createSphere(engine, { diameter: 1, segments: 5 });
    sphere.name = "distanceSphere1";
    sphere.position.set(curX, 1, 0);
    sphere.material = makeMaterial(col);
    addToScene(scene, sphere);
    const box = addBox(scene, engine, "distanceBox1", curX, 1, -2, 1, 1, 1, col);
    const agg1 = createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, { mass: 0, restitution: 0.9 });
    const agg2 = addAggregate(world, box, 1);
    createPhysicsConstraint(world, agg1.body, agg2.body, PhysicsConstraintType.DISTANCE, { maxDistance: 2 });
    curX += 2;
}

function hinge(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld): void {
    const col = colorFor(2);
    const box1 = addBox(scene, engine, "hingeBox1", curX, 1, 0, 1, 0.2, 1, col);
    const box2 = addBox(scene, engine, "hingeBox2", curX, 1, -1, 1, 0.2, 1, col);
    const agg1 = addAggregate(world, box1, 0);
    const agg2 = addAggregate(world, box2, 1);
    createPhysicsConstraint(world, agg1.body, agg2.body, PhysicsConstraintType.HINGE, {
        pivotA: { x: 0, y: 0, z: -0.5 },
        pivotB: { x: 0, y: 0, z: 0.5 },
        axisA: { x: 1, y: 0, z: 0 },
        axisB: { x: 1, y: 0, z: 0 },
    });
    curX += 2;
}

function prismatic(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld, slider = false): void {
    const col = colorFor(slider ? 5 : 3);
    const box1 = addBox(scene, engine, slider ? "sliderBox1" : "prismaticBox1", curX, 0, 0, 0.2, 3, 0.2, col);
    const box2 = addBox(scene, engine, slider ? "sliderBox2" : "prismaticBox2", curX, 1.5, -0.2, 0.2, 0.5, 0.2, col);
    const box3 = addBox(scene, engine, slider ? "sliderBase" : "prismaticBase", curX, -1.5, 0, 1.5, 0.1, 1.5, col);
    const agg1 = addAggregate(world, box1, 0);
    const agg2 = addAggregate(world, box2, 1);
    addAggregate(world, box3, 0);
    createPhysicsConstraint(world, agg1.body, agg2.body, slider ? PhysicsConstraintType.SLIDER : PhysicsConstraintType.PRISMATIC, {
        pivotA: { x: 0, y: 0, z: -0.2 },
        pivotB: { x: 0, y: 0, z: 0.25 },
        axisA: { x: 0, y: 1, z: 0 },
        axisB: { x: 0, y: 1, z: 0 },
    });
    curX += 2;
}

function locked(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld): void {
    const col = colorFor(4);
    const box1 = addBox(scene, engine, "fixedBox1", curX, 0, 0, 1, 1, 1, col);
    const box2 = addBox(scene, engine, "fixedBox2", curX, 0, -2, 1, 1, 1, col);
    const agg1 = addAggregate(world, box1, 0);
    const agg2 = addAggregate(world, box2, 1);
    createPhysicsConstraint(world, agg1.body, agg2.body, PhysicsConstraintType.LOCK, {
        pivotA: { x: 0.5, y: 0.5, z: -0.5 },
        pivotB: { x: -0.5, y: -0.5, z: 0.5 },
        axisA: { x: 0, y: 1, z: 0 },
        axisB: { x: 0, y: 1, z: 0 },
    });
    curX += 2;
}

function sixdof(scene: ReturnType<typeof createSceneContext>, engine: Awaited<ReturnType<typeof createEngine>>, world: PhysicsWorld): void {
    const col = colorFor(6);
    const box1 = addBox(scene, engine, "sixdofBox1", curX, 0, 0, 1, 1, 1, col);
    const box2 = addBox(scene, engine, "sixdofBox2", curX, 1.5, -0.2, 1, 1, 1, col);
    const agg1 = addAggregate(world, box1, 0);
    const agg2 = addAggregate(world, box2, 1);
    createPhysicsConstraint(
        world,
        agg1.body,
        agg2.body,
        PhysicsConstraintType.SIX_DOF,
        { pivotA: { x: 0, y: -0.5, z: 0 }, pivotB: { x: 0, y: 0.5, z: 0 }, perpAxisA: { x: 1, y: 0, z: 0 }, perpAxisB: { x: 1, y: 0, z: 0 } },
        [{ axis: PhysicsConstraintAxis.LINEAR_DISTANCE, minLimit: 1, maxLimit: 2 }]
    );
    curX += 2;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    curX = -8;
    scene.camera = createFreeCamera({ x: 0, y: 4, z: -24 }, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);
    const light2 = createHemisphericLight([0, -1, 0]);
    light2.intensity = 0.2;
    addToScene(scene, light2);

    let simulationStarted = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        if (simulationStarted) {
            simulatedFrames++;
        }
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => stopEngine(engine), 0);
        }
    });

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });

    ballAndSocket(scene, engine, world);
    distance(scene, engine, world);
    hinge(scene, engine, world);
    prismatic(scene, engine, world);
    locked(scene, engine, world);
    prismatic(scene, engine, world, true);
    sixdof(scene, engine, world);

    await registerScene(scene);
    await startEngine(engine);
    simulationStarted = true;
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
