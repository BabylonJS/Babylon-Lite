import HavokPhysics from "@babylonjs/havok";
import {
    applyPhysicsBodyInstanceImpulse,
    createEngine,
    createHavokWorld,
    createMeshFromData,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    disposeEngine,
    disposePhysics,
    enableHavokThinInstancePhysics,
    getMeshGeometry,
    getPhysicsBodyInstanceLinearVelocityToRef,
    onPhysicsCollision,
    physicsRaycast,
    PhysicsMotionType,
    PhysicsShapeType,
    setPhysicsBodyCollisionEventsEnabled,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMass,
    setPhysicsBodyShape,
    setPhysicsGravity,
    setThinInstances,
} from "babylon-lite";
import type { Mesh, PhysicsBody, PhysicsWorld, SceneContext } from "babylon-lite";
import { loadPlayroomAssets } from "../demos/playroom/assets.js";
import { PLAYROOM_LAYOUT } from "../demos/playroom/layout.js";
import { createPuzzleRandom, expandPuzzle } from "../demos/playroom/puzzles.js";
import type { BodyRecord, PlayroomAssets, WorldState } from "../demos/playroom/types.js";
import { buildPlayroomWorld } from "../demos/playroom/world.js";

interface MatrixStage {
    readonly matrix: number[];
    readonly determinant: number;
    readonly worldVertices: number[][];
    readonly nativeId: string;
}

interface InstanceStages {
    readonly batchKey: string;
    readonly instanceIndex: number;
    readonly shapeCenter: number[];
    readonly beforeNativeCreation: MatrixStage;
    afterNativeCreation: MatrixStage;
    firstZeroGravitySync: MatrixStage;
    firstGravityContact?: MatrixStage;
}

interface ShapeCall {
    readonly id: string;
    readonly type: string;
    readonly center?: number[];
    readonly extents?: number[];
    readonly pointA?: number[];
    readonly pointB?: number[];
    readonly radius?: number;
    readonly vertexCount?: number;
    readonly triangleCount?: number;
    readonly children?: string[];
    readonly childTransforms?: number[][][];
}

interface PhysicsHarnessSnapshot {
    readonly schemaVersion: 1;
    readonly sourceRevision: string;
    readonly counts: {
        readonly logicalRecords: number;
        readonly propBatchRecords: number;
        readonly activeRenderInstances: number;
        readonly nativeBodies: number;
    };
    readonly records: ReadonlyArray<{
        readonly batchKey: string;
        readonly model: string;
        readonly renderInstanceCount: number;
        readonly nativeInstanceCount: number;
        readonly nativeIds: string[];
        readonly nativeShapeIds: string[];
        readonly shape: ShapeCall;
    }>;
    readonly cubeStages: InstanceStages[];
    readonly indexedControls: ReadonlyArray<{
        readonly batchKey: string;
        readonly firstIndex: number;
        readonly lastIndex: number;
        readonly firstVelocity: number[];
        readonly middleVelocity: number[];
        readonly lastVelocity: number[];
        readonly raycastIndex: number;
    }>;
    readonly contacts: ReadonlyArray<{ readonly batchKey: string; readonly instanceIndex: number }>;
    readonly carrierReflectionProbe: {
        readonly nativeAfterCreation: MatrixStage;
        readonly effectiveAfterWriteBack: MatrixStage;
        readonly nativeShape: ShapeCall;
    };
}

function id(handle: unknown): string {
    return String((handle as ArrayLike<unknown>)[0]);
}

function copy3(value: ArrayLike<number>): number[] {
    return [value[0]!, value[1]!, value[2]!];
}

function installShapeObserver(hknp: any): { shapes: Map<string, ShapeCall>; bodyShapes: Map<string, string> } {
    const shapes = new Map<string, ShapeCall>();
    const bodyShapes = new Map<string, string>();
    const wrap = (name: string, type: string, describe: (args: any[]) => Omit<ShapeCall, "id" | "type">): void => {
        const original = hknp[name].bind(hknp);
        hknp[name] = (...args: any[]) => {
            const result = original(...args);
            shapes.set(id(result[1]), { id: id(result[1]), type, ...describe(args) });
            return result;
        };
    };
    wrap("HP_Shape_CreateBox", "box", ([center, , extents]) => ({ center: copy3(center), extents: copy3(extents) }));
    wrap("HP_Shape_CreateSphere", "sphere", ([center, radius]) => ({ center: copy3(center), radius }));
    wrap("HP_Shape_CreateCylinder", "cylinder", ([pointA, pointB, radius]) => ({ pointA: copy3(pointA), pointB: copy3(pointB), radius }));
    wrap("HP_Shape_CreateConvexHull", "convex", ([, vertexCount]) => ({ vertexCount }));
    wrap("HP_Shape_CreateMesh", "mesh", ([, vertexCount, , triangleCount]) => ({ vertexCount, triangleCount }));
    wrap("HP_Shape_CreateContainer", "container", () => ({ children: [], childTransforms: [] }));
    const addChild = hknp.HP_Shape_AddChild.bind(hknp);
    hknp.HP_Shape_AddChild = (container: unknown, child: unknown, transform: number[][]) => {
        const containerShape = shapes.get(id(container));
        containerShape?.children?.push(id(child));
        containerShape?.childTransforms?.push(transform.map((component) => component.slice()));
        return addChild(container, child, transform);
    };
    const setShape = hknp.HP_Body_SetShape.bind(hknp);
    hknp.HP_Body_SetShape = (body: unknown, shape: unknown) => {
        bodyShapes.set(id(body), id(shape));
        return setShape(body, shape);
    };
    return { shapes, bodyShapes };
}

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
    const result = new Array<number>(16);
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            result[column * 4 + row] = a[row]! * b[column * 4]! + a[row + 4]! * b[column * 4 + 1]! + a[row + 8]! * b[column * 4 + 2]! + a[row + 12]! * b[column * 4 + 3]!;
        }
    }
    return result;
}

function determinant(matrix: ArrayLike<number>): number {
    return (
        matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) +
        matrix[1]! * (matrix[6]! * matrix[8]! - matrix[4]! * matrix[10]!) +
        matrix[2]! * (matrix[4]! * matrix[9]! - matrix[5]! * matrix[8]!)
    );
}

function transformPoint(matrix: ArrayLike<number>, point: ArrayLike<number>): number[] {
    return [
        matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
        matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
        matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!,
    ];
}

function selectedVertices(mesh: Mesh): number[][] {
    const geometry = getMeshGeometry(mesh);
    if (!geometry) {
        throw new Error(`Missing retained geometry for ${mesh.name}.`);
    }
    const count = geometry.positions.length / 3;
    return [0, Math.floor(count / 2), count - 1].map((index) => Array.from(geometry.positions.slice(index * 3, index * 3 + 3)));
}

function effectiveMatrix(mesh: Mesh, index: number): number[] {
    return multiply(mesh.worldMatrix, mesh.thinInstances!.matrices.slice(index * 16, index * 16 + 16));
}

function nativeMatrix(world: PhysicsWorld, body: PhysicsBody, index: number): number[] {
    const native = world._thin?.instance(body, index);
    const matrix = native && world._thin?.matrix(body, native);
    if (!matrix) {
        throw new Error(`Missing native transform for instance ${index}.`);
    }
    return Array.from(matrix);
}

function stage(matrix: number[], vertices: readonly number[][], nativeId: string): MatrixStage {
    return { matrix, determinant: determinant(matrix), worldVertices: vertices.map((point) => transformPoint(matrix, point)), nativeId };
}

function recordBatchKeys(assets: PlayroomAssets): Array<{ key: string; model: string }> {
    const random = createPuzzleRandom(0x504c4159);
    const familyIndices = new Map<string, number>();
    const keys: Array<{ key: string; model: string }> = [];
    for (const entry of PLAYROOM_LAYOUT) {
        const familyIndex = familyIndices.get(entry.family) ?? 0;
        familyIndices.set(entry.family, familyIndex + 1);
        const placementKey = `${entry.family}/${String(familyIndex).padStart(3, "0")}`;
        for (const batch of expandPuzzle(entry, random, assets.models)) {
            keys.push({ key: `${placementKey}/${batch.model}`, model: batch.model });
        }
    }
    return keys;
}

function recordMap(world: WorldState, assets: PlayroomAssets): Map<string, BodyRecord> {
    const entries = recordBatchKeys(assets);
    return new Map(entries.map((entry, index) => [entry.key, world.records[index + 5]!]));
}

function captureCubeStages(
    world: PhysicsWorld,
    records: Map<string, BodyRecord>,
    shapes: ReadonlyMap<string, ShapeCall>,
    checkpoint: "before" | "after" | "zero",
    existing: InstanceStages[] = []
): InstanceStages[] {
    const cohorts = [
        ["cubeStack/000/cube", [0, 20, 39]],
        ["cubes/003/cube", [0, 13, 26]],
    ] as const;
    const result = existing.length ? existing : [];
    let outputIndex = 0;
    for (const [batchKey, indices] of cohorts) {
        const record = records.get(batchKey)!;
        const mesh = record.mesh as Mesh;
        const vertices = selectedVertices(mesh);
        for (const instanceIndex of indices) {
            const native = world._thin!.instance(record.body, instanceIndex)!;
            const nativeId = id(native);
            const render = stage(effectiveMatrix(mesh, instanceIndex), vertices, nativeId);
            const nativeStage = stage(nativeMatrix(world, record.body, instanceIndex), vertices, nativeId);
            if (checkpoint === "before") {
                result.push({
                    batchKey,
                    instanceIndex,
                    shapeCenter: shapes.get(id(record.shape!._hkShape))?.center ?? [0, 0, 0],
                    beforeNativeCreation: render,
                    afterNativeCreation: nativeStage,
                    firstZeroGravitySync: nativeStage,
                });
            } else if (checkpoint === "after") {
                result[outputIndex]!.afterNativeCreation = nativeStage;
            } else {
                result[outputIndex]!.firstZeroGravitySync = render;
            }
            outputIndex++;
        }
    }
    return result;
}

function step(scene: SceneContext): void {
    scene._beforeRender[0]!(1000 / 60);
}

function velocity(world: PhysicsWorld, body: PhysicsBody, index: number): number[] {
    const result = { x: 0, y: 0, z: 0 };
    getPhysicsBodyInstanceLinearVelocityToRef(world, body, index, result);
    return [result.x, result.y, result.z];
}

function indexedControlEvidence(world: PhysicsWorld, records: Map<string, BodyRecord>): PhysicsHarnessSnapshot["indexedControls"] {
    const output: Array<PhysicsHarnessSnapshot["indexedControls"][number]> = [];
    for (const batchKey of ["cubeStack/000/cube", "cubes/003/cube"]) {
        const record = records.get(batchKey)!;
        const count = (record.mesh as Mesh).thinInstances!.count;
        const middle = Math.floor(count / 2);
        const last = count - 1;
        const firstPosition = effectiveMatrix(record.mesh as Mesh, 0).slice(12, 15);
        const lastPosition = effectiveMatrix(record.mesh as Mesh, last).slice(12, 15);
        applyPhysicsBodyInstanceImpulse(world, record.body, 0, { x: 0.001, y: 0, z: 0 }, { x: firstPosition[0]!, y: firstPosition[1]!, z: firstPosition[2]! });
        applyPhysicsBodyInstanceImpulse(world, record.body, last, { x: -0.001, y: 0, z: 0 }, { x: lastPosition[0]!, y: lastPosition[1]!, z: lastPosition[2]! });
        const ray = physicsRaycast(
            world,
            { x: lastPosition[0]!, y: lastPosition[1]! + 1, z: lastPosition[2]! },
            { x: lastPosition[0]!, y: lastPosition[1]! - 1, z: lastPosition[2]! }
        );
        output.push({
            batchKey,
            firstIndex: 0,
            lastIndex: last,
            firstVelocity: velocity(world, record.body, 0),
            middleVelocity: velocity(world, record.body, middle),
            lastVelocity: velocity(world, record.body, last),
            raycastIndex: ray.body === record.body ? ray.bodyIndex : -1,
        });
        setPhysicsBodyLinearVelocity(world, record.body, { x: 0, y: 0, z: 0 });
    }
    return output;
}

async function carrierReflectionProbe(engine: Awaited<ReturnType<typeof createEngine>>, hknp: any): Promise<PhysicsHarnessSnapshot["carrierReflectionProbe"]> {
    const observation = installShapeObserver(hknp);
    const scene = createSceneContext(engine);
    const world = createHavokWorld(scene, hknp, { x: 0, y: 0, z: 0 });
    await enableHavokThinInstancePhysics(world);
    const mesh = createMeshFromData(
        engine,
        "carrier-reflection-probe",
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        new Uint32Array([0, 1, 2])
    );
    mesh.position.set(10, 20, 30);
    mesh.rotationQuaternion.set(0, 0, Math.SQRT1_2, Math.SQRT1_2);
    const matrices = new Float32Array([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
    setThinInstances(mesh, matrices, 1);
    const shape = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { extents: { x: 1, y: 1, z: 1 } } });
    const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC, true);
    setPhysicsBodyShape(world, body, shape);
    setPhysicsBodyMass(world, body, 1);
    const nativeId = id(world._thin!.instance(body, 0)!);
    const nativeShape = observation.shapes.get(observation.bodyShapes.get(nativeId)!)!;
    const vertices = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
    ];
    const nativeAfterCreation = stage(nativeMatrix(world, body, 0), vertices, nativeId);
    step(scene);
    const effectiveAfterWriteBack = stage(effectiveMatrix(mesh, 0), vertices, nativeId);
    disposePhysics(world);
    return { nativeAfterCreation, effectiveAfterWriteBack, nativeShape };
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const hknp = await HavokPhysics({ locateFile: () => new URL("/HavokPhysics.wasm", window.location.href).href });
    const observation = installShapeObserver(hknp);
    const shapes = observation.shapes;
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / 60;
    const assets = await loadPlayroomAssets(engine, new URL("/playroom-oracle-entry.js", window.location.href).href);
    const physics = createHavokWorld(scene, hknp, { x: 0, y: 0, z: 0 });
    await enableHavokThinInstancePhysics(physics);
    const world = buildPlayroomWorld(engine, scene, physics, assets);
    const records = recordMap(world, assets);
    const cubeStages = captureCubeStages(physics, records, shapes, "before");
    captureCubeStages(physics, records, shapes, "after", cubeStages);
    step(scene);
    captureCubeStages(physics, records, shapes, "zero", cubeStages);
    const indexedControls = indexedControlEvidence(physics, records);

    const contacts: Array<{ batchKey: string; instanceIndex: number }> = [];
    const keysByBody = new Map([...records].map(([key, record]) => [record.body, key]));
    for (const batchKey of ["cubeStack/000/cube", "cubes/003/cube"]) {
        setPhysicsBodyCollisionEventsEnabled(physics, records.get(batchKey)!.body, true);
    }
    setPhysicsBodyCollisionEventsEnabled(physics, world.records[0]!.body, true);
    onPhysicsCollision(physics, (info) => {
        if (info.type === "FINISHED") {
            return;
        }
        const key = keysByBody.get(info.collider) ?? keysByBody.get(info.collidedAgainst);
        if (key) {
            const instanceIndex = keysByBody.has(info.collider) ? info.colliderIndex : info.collidedAgainstIndex;
            if (!contacts.some((entry) => entry.batchKey === key && entry.instanceIndex === instanceIndex)) {
                contacts.push({ batchKey: key, instanceIndex });
            }
        }
    });
    setPhysicsGravity(physics, { x: 0, y: -9.81, z: 0 });
    for (const marker of cubeStages) {
        const record = records.get(marker.batchKey)!;
        const position = marker.firstZeroGravitySync.matrix.slice(12, 15);
        applyPhysicsBodyInstanceImpulse(physics, record.body, marker.instanceIndex, { x: 0, y: -0.002, z: 0 }, { x: position[0]!, y: position[1]!, z: position[2]! });
    }
    for (let frame = 0; frame < 120; frame++) {
        step(scene);
        for (const marker of cubeStages) {
            if (!marker.firstGravityContact && contacts.some((contact) => contact.batchKey === marker.batchKey && contact.instanceIndex === marker.instanceIndex)) {
                const record = records.get(marker.batchKey)!;
                marker.firstGravityContact = stage(
                    effectiveMatrix(record.mesh as Mesh, marker.instanceIndex),
                    selectedVertices(record.mesh as Mesh),
                    id(physics._thin!.instance(record.body, marker.instanceIndex)!)
                );
            }
        }
    }

    const recordsOutput = [...records].map(([batchKey, record]) => {
        const mesh = record.mesh as Mesh;
        const count = mesh.thinInstances!.count;
        return {
            batchKey,
            model: batchKey.split("/").at(-1)!,
            renderInstanceCount: count,
            nativeInstanceCount: physics._thin!.count(record.body)!,
            nativeIds: Array.from({ length: count }, (_, index) => id(physics._thin!.instance(record.body, index)!)),
            nativeShapeIds: Array.from({ length: count }, (_, index) => observation.bodyShapes.get(id(physics._thin!.instance(record.body, index)!))!),
            shape: shapes.get(id(record.shape!._hkShape))!,
        };
    });
    const carrierProbeHknp = await HavokPhysics({ locateFile: () => new URL("/HavokPhysics.wasm", window.location.href).href });
    const snapshot: PhysicsHarnessSnapshot = {
        schemaVersion: 1,
        sourceRevision: "d22ce23ef308e28d1f8b6598b4c72ea944205925",
        counts: {
            logicalRecords: world.records.length,
            propBatchRecords: records.size,
            activeRenderInstances: recordsOutput.reduce((sum, record) => sum + record.renderInstanceCount, 0),
            nativeBodies: world.records.reduce((sum, record) => sum + (physics._thin?.count(record.body) ?? 1), 0),
        },
        records: recordsOutput,
        cubeStages,
        indexedControls,
        contacts,
        carrierReflectionProbe: await carrierReflectionProbe(engine, carrierProbeHknp),
    };
    const output = document.createElement("script");
    output.id = "playroom-physics-snapshot";
    output.type = "application/json";
    output.textContent = JSON.stringify(snapshot);
    document.body.append(output);
    canvas.dataset.ready = "true";
    window.addEventListener(
        "pagehide",
        () => {
            disposePhysics(physics);
            disposeEngine(engine);
        },
        { once: true }
    );
}

void main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
