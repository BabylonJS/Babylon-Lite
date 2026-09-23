import {
    addPhysicsShapeChild,
    addToScene,
    cloneTransformNode,
    createGround,
    createPbrMaterial,
    createPhysicsBody,
    createPhysicsShape,
    getPhysicsBodyInstanceCount,
    createTransformNode,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    setPhysicsBodyCollisionEventsEnabled,
    setPhysicsBodyMotionType,
    setPhysicsBodyMass,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    setThinInstanceColors,
    setThinInstanceCount,
    setThinInstances,
    releasePhysicsShape,
    removeFromScene,
    removePhysicsBody,
} from "babylon-lite";
import { capturePhysicsBodyInstanceResetState, resetPhysicsBodyInstances } from "./physics-instances.js";
import type { EngineContext, Mesh, PhysicsShape, PhysicsWorld, SceneContext } from "babylon-lite";
import { PLAYROOM_LAYOUT } from "./layout.js";
import { createPuzzleRandom, expandPuzzle, type PuzzleBatch } from "./puzzles.js";
import type { BodyRecord, PlayroomAssets, WorldState } from "./types.js";

function createWorldState(): WorldState {
    return {
        records: [],
        bodiesByObject: new Map(),
        aggregates: [],
        constraints: [],
        shapes: [],
        meshes: [],
        poppers: [],
        nextBodyId: 1,
    };
}

function remember(state: WorldState, record: BodyRecord): BodyRecord {
    state.records.push(record);
    state.bodiesByObject.set(record.body, record);
    if (record.family === "popper") {
        state.poppers.push(record);
    }
    return record;
}

export interface BoxCollider {
    readonly center: readonly [number, number, number];
    readonly extents: readonly [number, number, number];
}

export function boxColliderForModel(model: string, bounds: BoxCollider): BoxCollider {
    if (model === "domino") {
        return { center: [0, 0.16, 0], extents: [0.176, 0.32, 0.042] };
    }
    if (model === "transformedTowerGameBlock") {
        return { center: [0, 0, 0], extents: [0.5, 1.5, 0.3] };
    }
    if (model === "chessboard") {
        return {
            center: bounds.center,
            extents: [bounds.extents[0] * 0.6, bounds.extents[1] * 0.6, bounds.extents[2] * 0.6],
        };
    }
    return bounds;
}

function shapeForBatch(world: PhysicsWorld, mesh: Mesh, batch: PuzzleBatch, assets: PlayroomAssets, state: WorldState): PhysicsShape {
    let shape: PhysicsShape;
    switch (batch.shape) {
        case "sphere":
            shape = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { radius: 0.5 } });
            break;
        case "cylinder":
            shape = createPhysicsShape(world, { type: PhysicsShapeType.CYLINDER, parameters: { pointA: { x: 0, y: 0, z: 0 }, pointB: { x: 0, y: 0.6, z: 0 }, radius: 0.12 } });
            break;
        case "convex":
            shape = createPhysicsShape(world, { type: PhysicsShapeType.CONVEX_HULL, mesh });
            break;
        case "mesh":
            shape = createPhysicsShape(world, { type: PhysicsShapeType.MESH, mesh });
            break;
        case "arch": {
            shape = createPhysicsShape(world, { type: PhysicsShapeType.CONTAINER });
            const left = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center: { x: -0.3696, y: 0.2, z: 0 }, extents: { x: 0.3696, y: 0.4, z: 0.4 } } });
            const right = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center: { x: 0.3696, y: 0.2, z: 0 }, extents: { x: 0.3696, y: 0.4, z: 0.4 } } });
            const middle = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center: { x: 0, y: 0.3, z: 0 }, extents: { x: 0.3696, y: 0.2, z: 0.4 } } });
            addPhysicsShapeChild(world, shape, left);
            addPhysicsShapeChild(world, shape, right);
            addPhysicsShapeChild(world, shape, middle);
            state.shapes.push(left, right, middle);
            break;
        }
        case "box": {
            const collider = boxColliderForModel(batch.model, assets.models[batch.model]!.collisionBounds);
            shape = createPhysicsShape(world, {
                type: PhysicsShapeType.BOX,
                parameters: {
                    center: { x: collider.center[0], y: collider.center[1], z: collider.center[2] },
                    extents: { x: collider.extents[0], y: collider.extents[1], z: collider.extents[2] },
                },
            });
            break;
        }
    }
    setPhysicsShapeMaterial(world, shape, batch.friction, batch.restitution);
    state.shapes.push(shape);
    return shape;
}

function addBatch(scene: SceneContext, world: PhysicsWorld, assets: PlayroomAssets, batch: PuzzleBatch, state: WorldState, popperIndex?: number): BodyRecord {
    const template = assets.models[batch.model];
    if (!template) {
        throw new Error(`The Playroom has no model template named ${batch.model}.`);
    }
    const mesh = cloneTransformNode(template.mesh) as Mesh;
    mesh.name = `${batch.family}-${state.nextBodyId}`;
    if (batch.model === "chessWhite" || batch.model === "chessBlack" || batch.model === "cube" || batch.model.startsWith("arch")) {
        const color: [number, number, number, number] = batch.model === "chessBlack" ? [0.015, 0.015, 0.02, 1] : [0.9, 0.9, 0.88, 1];
        mesh.material = createPbrMaterial({ baseColorFactor: color, metallicFactor: 0, roughnessFactor: batch.model.startsWith("chess") ? 1 : 0.3 });
    }
    setThinInstances(mesh, batch.matrices, batch.matrices.length / 16);
    if (batch.colors) {
        setThinInstanceColors(mesh, batch.colors);
    }
    addToScene(scene, mesh);
    state.meshes.push(mesh);
    const shape = shapeForBatch(world, mesh, batch, assets, state);
    const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC, true);
    setPhysicsBodyPrestepType(body, PhysicsPrestepType.DISABLED);
    setPhysicsBodyShape(world, body, shape);
    setPhysicsBodyMass(world, body, batch.mass);
    const initialInstanceCount = getPhysicsBodyInstanceCount(body);
    const expectedInstanceCount = batch.matrices.length / 16;
    if (initialInstanceCount !== expectedInstanceCount) {
        throw new Error(`Playroom batch ${mesh.name} created ${initialInstanceCount} physics bodies instead of ${expectedInstanceCount}.`);
    }
    capturePhysicsBodyInstanceResetState(world, body);
    return remember(state, {
        id: state.nextBodyId++,
        family: batch.family,
        body,
        mesh,
        mass: batch.mass,
        shape,
        scored: new Set(),
        audioTags: audioTagsForBatch(batch),
        popperIndex,
        initialInstanceCount,
        active: true,
        resetGeneration: 0,
    });
}

function audioTagsForBatch(batch: PuzzleBatch): readonly string[] {
    switch (batch.family) {
        case "domino":
            return ["domino"];
        case "stack":
        case "tower":
            return ["hard", "wood", "block"];
        case "cup":
            return ["hard", "plastic", "cup"];
        case "bowlingBall":
            return ["hard", "plastic", "bowlingBall"];
        case "bowlingPins":
            return ["hard", "plastic", "bowlingPin"];
        case "ramp":
            return ["hard", "plastic", "ramp"];
        case "cubeStack":
        case "cubes":
        case "arch":
            return ["hard", "plastic", "block"];
        case "popper":
            return ["hard", "plastic", "popper"];
        case "chess":
            return batch.model === "chessboard" ? ["hard", "plastic", "chessBoard"] : ["hard", "plastic", "chessPiece"];
    }
}

function addGroundAndWalls(engine: EngineContext, scene: SceneContext, world: PhysicsWorld, assets: PlayroomAssets, state: WorldState): void {
    const ground = createGround(engine, { width: 40, height: 40 });
    ground.name = "playroom-ground";
    ground.position.y = 0.05;
    ground.material = assets.rugMaterial;
    ground.receiveShadows = true;
    addToScene(scene, ground);
    state.meshes.push(ground);
    const groundShape = createPhysicsShape(world, {
        type: PhysicsShapeType.BOX,
        parameters: { center: { x: 0, y: -0.05, z: 0 }, extents: { x: 600, y: 0.1, z: 600 } },
    });
    setPhysicsShapeMaterial(world, groundShape, 0.9, 0.1);
    const groundBody = createPhysicsBody(world, ground, PhysicsMotionType.STATIC, true);
    setPhysicsBodyShape(world, groundBody, groundShape);
    setPhysicsBodyMass(world, groundBody, 0);
    state.shapes.push(groundShape);
    remember(state, {
        id: state.nextBodyId++,
        family: "ground",
        body: groundBody,
        mesh: ground,
        mass: 0,
        shape: groundShape,
        scored: new Set(),
        audioTags: ["soft", "ground"],
        active: true,
        resetGeneration: 0,
    });

    const walls = [
        [
            { x: 18, y: 18, z: 0 },
            { x: 0.2, y: 36, z: 36 },
        ],
        [
            { x: -18, y: 18, z: 0 },
            { x: 0.2, y: 36, z: 36 },
        ],
        [
            { x: 0, y: 18, z: 18 },
            { x: 36, y: 36, z: 0.2 },
        ],
        [
            { x: 0, y: 18, z: -18 },
            { x: 36, y: 36, z: 0.2 },
        ],
    ] as const;
    for (const [center, extents] of walls) {
        const node = createTransformNode("playroom-wall");
        const shape = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center, extents } });
        setPhysicsShapeMaterial(world, shape, 0.9, 0.1);
        const body = createPhysicsBody(world, node, PhysicsMotionType.STATIC, true);
        setPhysicsBodyShape(world, body, shape);
        setPhysicsBodyMass(world, body, 0);
        state.shapes.push(shape);
        remember(state, {
            id: state.nextBodyId++,
            family: "wall",
            body,
            mesh: node,
            mass: 0,
            shape,
            scored: new Set(),
            audioTags: [],
            active: true,
            resetGeneration: 0,
        });
    }
}

export function buildPlayroomWorld(engine: EngineContext, scene: SceneContext, world: PhysicsWorld, assets: PlayroomAssets): WorldState {
    const state = createWorldState();
    addGroundAndWalls(engine, scene, world, assets, state);
    let popperIndex = 0;
    const random = createPuzzleRandom(0x504c4159);
    for (let i = 0; i < PLAYROOM_LAYOUT.length; i++) {
        const entry = PLAYROOM_LAYOUT[i]!;
        for (const batch of expandPuzzle(entry, random, assets.models)) {
            addBatch(scene, world, assets, batch, state, entry.family === "popper" ? popperIndex++ : undefined);
        }
    }
    return state;
}

export function resetPlayroomWorld(physics: PhysicsWorld, state: WorldState): void {
    for (const record of state.records) {
        record.scored.clear();
        if (record.initialInstanceCount === undefined) {
            continue;
        }
        const wasActive = record.active !== false;
        record.active = true;
        record.resetGeneration = (record.resetGeneration ?? 0) + 1;
        record.mesh.visible = true;
        if (!wasActive) {
            setPhysicsBodyMotionType(physics, record.body, PhysicsMotionType.DYNAMIC);
            setPhysicsBodyCollisionEventsEnabled(physics, record.body, true);
            setThinInstanceCount(record.mesh as Mesh, record.initialInstanceCount);
        }
        resetPhysicsBodyInstances(physics, record.body);
    }
}

export function disposePlayroomWorld(scene: SceneContext, physics: PhysicsWorld, state: WorldState): void {
    for (const record of state.records) {
        if (state.bodiesByObject.has(record.body)) {
            removePhysicsBody(physics, record.body);
        }
        removeFromScene(scene, record.mesh);
    }
    for (const shape of state.shapes) {
        releasePhysicsShape(physics, shape);
    }
}
