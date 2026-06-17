// Scene 47: Physics V2 — Havok heightfield with two falling rows of shapes.
//
// Row 1 (aggregates, all types): BOX, SPHERE, CAPSULE, CYLINDER, CONVEX_HULL, MESH.
// Row 2 (body + shape, all types): BOX, SPHERE, CAPSULE, CYLINDER, CONVEX_HULL, MESH.
// CONVEX_HULL and MESH use the seagull glb as both visual mesh and shape source.
// The static heightfield body is derived from the SAME heightMap.png that builds
// the visible ground (matching scene22), so objects land on the visible terrain.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    cloneTransformNode,
    createArcRotateCamera,
    createBox,
    createCapsule,
    createCylinder,
    createEngine,
    createGroundFromHeightMap,
    createHavokWorld,
    createHeightFieldShape,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    createPhysicsViewer,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    loadGltf,
    onBeforeRender,
    onPhysicsAfterStep,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMass,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    setPhysicsTimestep,
    showPhysicsBody,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { AssetContainer, EngineContext, Mesh, PhysicsShapeParameters, PhysicsViewer, PhysicsWorld, SceneNode } from "babylon-lite";

const PHYSICS_FPS = 60;
const HEIGHTMAP_URL = "https://playground.babylonjs.com/textures/heightMap.png";
const SEAGULL_URL = "https://playground.babylonjs.com/scenes/seagulf.glb";
const SEAGULL_SCALE = 0.63695717914937;
const DROP_HEIGHT = 18;
const ROW1_Z = -5;
const ROW2_Z = 5;
const FRICTION = 0.5;
const RESTITUTION = 0.1;

const COLOR_BOX: [number, number, number] = [0.85, 0.27, 0.29];
const COLOR_SPHERE: [number, number, number] = [0.89, 0.71, 0.02];
const COLOR_CAPSULE: [number, number, number] = [0.34, 0.64, 0.65];
const COLOR_CYLINDER: [number, number, number] = [0.45, 0.55, 0.85];
const COLOR_HULL: [number, number, number] = [0.55, 0.78, 0.25];
const COLOR_MESH: [number, number, number] = [0.78, 0.36, 0.7];
const COLOR_GROUND: [number, number, number] = [0.52, 0.52, 0.52];

// Explicit geometry shared by both engines so Lite and BJS build byte-identical
// Havok shapes (auto-sizing heuristics differ between engines).
const BOX_PARAMS: PhysicsShapeParameters = { center: { x: 0, y: 0, z: 0 }, extents: { x: 2, y: 2, z: 2 } };
const SPHERE_PARAMS: PhysicsShapeParameters = { center: { x: 0, y: 0, z: 0 }, radius: 1 };
const CAPSULE_PARAMS: PhysicsShapeParameters = { pointA: { x: 0, y: -0.75, z: 0 }, pointB: { x: 0, y: 0.75, z: 0 }, radius: 0.75 };
const CYLINDER_PARAMS: PhysicsShapeParameters = { pointA: { x: 0, y: -1.5, z: 0 }, pointB: { x: 0, y: 1.5, z: 0 }, radius: 1 };

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

function createMaterial(color: [number, number, number]) {
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.specularColor = [0.08, 0.08, 0.08];
    material.backFaceCulling = false;
    return material;
}

function isMeshNode(node: unknown): node is Mesh {
    return typeof node === "object" && node !== null && "_gpu" in node;
}

function hasChildren(node: unknown): node is { children: SceneNode[] } {
    return typeof node === "object" && node !== null && "children" in node && Array.isArray((node as { children?: unknown }).children);
}

function collectMeshes(node: unknown, meshes: Mesh[]): void {
    if (isMeshNode(node)) {
        meshes.push(node);
    }
    if (hasChildren(node)) {
        for (const child of node.children) {
            collectMeshes(child, meshes);
        }
    }
}

function findPrimaryMesh(container: AssetContainer): Mesh {
    const meshes: Mesh[] = [];
    for (const entity of container.entities) {
        collectMeshes(entity, meshes);
    }
    const mesh = meshes[0];
    if (!mesh) {
        throw new Error("Scene 47 could not find seagull mesh geometry.");
    }
    return mesh;
}

function createPrimitiveVisual(engine: EngineContext, type: PhysicsShapeType, color: [number, number, number]): Mesh {
    let mesh: Mesh;
    switch (type) {
        case PhysicsShapeType.BOX:
            mesh = createBox(engine, 2);
            break;
        case PhysicsShapeType.SPHERE:
            mesh = createSphere(engine, { diameter: 2, segments: 24 });
            break;
        case PhysicsShapeType.CAPSULE:
            mesh = createCapsule(engine, { height: 3, radius: 0.75, tessellation: 24 });
            break;
        case PhysicsShapeType.CYLINDER:
        default:
            mesh = createCylinder(engine, { diameter: 2, height: 3, tessellation: 24 });
            break;
    }
    mesh.material = createMaterial(color);
    return mesh;
}

function primitiveParams(type: PhysicsShapeType): PhysicsShapeParameters {
    switch (type) {
        case PhysicsShapeType.BOX:
            return BOX_PARAMS;
        case PhysicsShapeType.SPHERE:
            return SPHERE_PARAMS;
        case PhysicsShapeType.CAPSULE:
            return CAPSULE_PARAMS;
        case PhysicsShapeType.CYLINDER:
        default:
            return CYLINDER_PARAMS;
    }
}

interface RowEntry {
    type: PhysicsShapeType;
    color: [number, number, number];
}

const ROW1: RowEntry[] = [
    { type: PhysicsShapeType.BOX, color: COLOR_BOX },
    { type: PhysicsShapeType.SPHERE, color: COLOR_SPHERE },
    { type: PhysicsShapeType.CAPSULE, color: COLOR_CAPSULE },
    { type: PhysicsShapeType.CYLINDER, color: COLOR_CYLINDER },
    { type: PhysicsShapeType.CONVEX_HULL, color: COLOR_HULL },
    { type: PhysicsShapeType.MESH, color: COLOR_MESH },
];

const ROW2: RowEntry[] = [
    { type: PhysicsShapeType.BOX, color: COLOR_BOX },
    { type: PhysicsShapeType.SPHERE, color: COLOR_SPHERE },
    { type: PhysicsShapeType.CAPSULE, color: COLOR_CAPSULE },
    { type: PhysicsShapeType.CYLINDER, color: COLOR_CYLINDER },
    { type: PhysicsShapeType.CONVEX_HULL, color: COLOR_HULL },
    { type: PhysicsShapeType.MESH, color: COLOR_MESH },
];

function rowXPositions(count: number, spacing: number): number[] {
    const xs: number[] = [];
    const start = -((count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) {
        xs.push(start + i * spacing);
    }
    return xs;
}

function createSeagullVisual(seagull: Mesh, color: [number, number, number]): Mesh {
    const mesh = cloneTransformNode(seagull) as Mesh;
    mesh.scaling.set(SEAGULL_SCALE, SEAGULL_SCALE, SEAGULL_SCALE);
    mesh.material = createMaterial(color);
    return mesh;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    scene.camera = createArcRotateCamera(-Math.PI / 2, 1.05, 48, { x: 0, y: 4, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    let physicsRunning = false;
    let captureQueued = false;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    // Visible terrain from heightMap.png (same image as scene22).
    const ground = await createGroundFromHeightMap(engine, HEIGHTMAP_URL, {
        width: 100,
        height: 100,
        subdivisions: 100,
        minHeight: 0,
        maxHeight: 10,
    });
    ground.material = createMaterial(COLOR_GROUND);
    addToScene(scene, ground);

    const seagull = findPrimaryMesh(await loadGltf(engine, SEAGULL_URL));

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });
    const viewer = createPhysicsViewer(scene, world, { color: [1, 1, 1, 1] });

    // Robust capture gate: keep physics paused (timestep 0) during the warm-up frames so the
    // debug wireframe overlay is fully rendered before any motion, then count ACTUAL physics
    // steps. This decouples the parity capture from GPU pipeline warm-up timing (the BJS
    // reference renders its PhysicsViewer overlay through an async-compiled utility layer that
    // is blank on the very first frames). Both scenes start physics from the identical settled
    // drop-height state and step the same number of times, so the captured frame matches.
    setPhysicsTimestep(world, 0);
    let physStep = 0;
    onPhysicsAfterStep(world, () => {
        if (!physicsRunning) {
            return;
        }
        physStep++;
        if (captureAfterFrames !== null && !captureQueued && physStep >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
    });

    // Static heightfield derived from the same ground mesh / heightMap.png.
    const groundShape = createHeightFieldShape(world, { groundMesh: ground });
    const groundBody = createPhysicsBody(world, ground, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, groundBody, groundShape);
    setPhysicsShapeMaterial(world, groundShape, FRICTION, RESTITUTION);
    showPhysicsBody(viewer, groundBody);

    // Row 1 — aggregates (primitives + seagull convex-hull and mesh aggregates).
    const row1X = rowXPositions(ROW1.length, 6);
    ROW1.forEach((entry, i) => {
        if (entry.type === PhysicsShapeType.CONVEX_HULL || entry.type === PhysicsShapeType.MESH) {
            const mesh = createSeagullVisual(seagull, entry.color);
            mesh.position.set(row1X[i]!, DROP_HEIGHT, ROW1_Z);
            addToScene(scene, mesh);
            // Build the mesh/convex-hull shape in the scene (createPhysicsShape's
            // mesh path is already bundled by Row 2) and hand it to the aggregate
            // via options.shape, keeping createPhysicsAggregate free of mesh code.
            const shape = createPhysicsShape(world, { type: entry.type, mesh });
            const aggregate = createPhysicsAggregate(world, mesh, entry.type, {
                mass: 1,
                friction: FRICTION,
                restitution: RESTITUTION,
                shape,
            });
            showPhysicsBody(viewer, aggregate.body);
            return;
        }
        const mesh = createPrimitiveVisual(engine, entry.type, entry.color);
        mesh.position.set(row1X[i]!, DROP_HEIGHT, ROW1_Z);
        addToScene(scene, mesh);
        const params = primitiveParams(entry.type);
        const aggregate = createPhysicsAggregate(world, mesh, entry.type, {
            mass: 1,
            friction: FRICTION,
            restitution: RESTITUTION,
            center: params.center,
            extents: params.extents,
            radius: params.radius,
            pointA: params.pointA,
            pointB: params.pointB,
        });
        showPhysicsBody(viewer, aggregate.body);
    });

    // Row 2 — body + shape (all shape types).
    const row2X = rowXPositions(ROW2.length, 6);
    ROW2.forEach((entry, i) => {
        let mesh: Mesh;
        let shape;
        if (entry.type === PhysicsShapeType.CONVEX_HULL || entry.type === PhysicsShapeType.MESH) {
            mesh = createSeagullVisual(seagull, entry.color);
            mesh.position.set(row2X[i]!, DROP_HEIGHT, ROW2_Z);
            addToScene(scene, mesh);
            shape = createPhysicsShape(world, { type: entry.type, mesh });
        } else {
            mesh = createPrimitiveVisual(engine, entry.type, entry.color);
            mesh.position.set(row2X[i]!, DROP_HEIGHT, ROW2_Z);
            addToScene(scene, mesh);
            shape = createPhysicsShape(world, { type: entry.type, parameters: primitiveParams(entry.type) });
        }
        bindDynamicBody(world, viewer, mesh, shape);
    });

    await registerScene(scene);
    await startEngine(engine);
    // The first rendered frame has drawn the inline wireframe overlay (Lite compiles its
    // pipelines synchronously, so the overlay is present immediately). Start stepping physics now.
    physicsRunning = true;
    setPhysicsTimestep(world, 1 / PHYSICS_FPS);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

function bindDynamicBody(world: PhysicsWorld, viewer: PhysicsViewer, node: SceneNode, shape: ReturnType<typeof createPhysicsShape>): void {
    const body = createPhysicsBody(world, node, PhysicsMotionType.DYNAMIC);
    setPhysicsBodyShape(world, body, shape);
    setPhysicsShapeMaterial(world, shape, FRICTION, RESTITUTION);
    setPhysicsBodyMass(world, body, 1);
    showPhysicsBody(viewer, body);
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
