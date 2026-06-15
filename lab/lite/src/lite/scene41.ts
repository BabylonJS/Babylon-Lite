// Scene 41: Physics V2 shape debug viewer — port of playground #LKPBW5

import HavokPhysics from "@babylonjs/havok";
import {
    addPhysicsShapeChildFromParent,
    addToScene,
    createArcRotateCamera,
    createEngine,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsBody,
    createPhysicsShape,
    createPhysicsViewer,
    createSceneContext,
    createStandardMaterial,
    cloneTransformNode,
    createTransformNode,
    loadBabylon,
    loadGltf,
    onBeforeRender,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMassProperties,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    showPhysicsBody,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { AssetContainer, EngineContext, Mesh, PhysicsShape, PhysicsViewer, PhysicsWorld, SceneNode } from "babylon-lite";

const PHYSICS_FPS = 60;
const ASSET_BASE = "https://playground.babylonjs.com/scenes/";
const SKULL_ROW_Z = 1.5;
const SEAGULL_ROW_Z = 6.5;
const SKULL_SCALE = 0.016403150060937705;
const SEAGULL_SCALE = 0.63695717914937;
const COLOR_MESH_SHAPE = hexToRgb("#DB504A");
const COLOR_HULL_SHAPE = hexToRgb("#E3B505");
const COLOR_AGGREGATE_SHAPE = hexToRgb("#56A3A6");
const COLOR_GROUND: [number, number, number] = [0.52, 0.52, 0.52];

interface ShapeRow {
    name: "skull" | "seagull";
    z: number;
    source: Mesh;
    scale: number;
}

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

function hexToRgb(hex: string): [number, number, number] {
    const value = Number.parseInt(hex.slice(1), 16);
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
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

function findPrimaryMesh(container: AssetContainer, label: string): Mesh {
    const meshes: Mesh[] = [];
    for (const entity of container.entities) {
        collectMeshes(entity, meshes);
    }
    const mesh = meshes[0];
    if (!mesh) {
        throw new Error(`Scene 41 could not find mesh geometry for ${label}.`);
    }
    return mesh;
}

async function loadShapeRows(engine: EngineContext): Promise<ShapeRow[]> {
    const [skull, seagull] = await Promise.all([
        loadBabylon(engine, `${ASSET_BASE}skull.babylon`, { loadCamera: false, loadTextures: false }),
        loadGltf(engine, `${ASSET_BASE}seagulf.glb`),
    ]);
    return [
        { name: "skull", z: SKULL_ROW_Z, source: findPrimaryMesh(skull, "skull"), scale: SKULL_SCALE },
        { name: "seagull", z: SEAGULL_ROW_Z, source: findPrimaryMesh(seagull, "seagull"), scale: SEAGULL_SCALE },
    ];
}

function createVisualMesh(row: ShapeRow, color: [number, number, number], x: number, suffix: string): Mesh {
    const mesh = cloneTransformNode(row.source) as Mesh;
    mesh.name = `${row.name}-${suffix}`;
    mesh.position.set(x, 2, row.z);
    mesh.scaling.set(row.scale, row.scale, row.scale);
    mesh.material = createMaterial(color);
    return mesh;
}

function bindBodyShape(world: PhysicsWorld, viewer: PhysicsViewer, node: SceneNode, shape: PhysicsShape): void {
    const body = createPhysicsBody(world, node, PhysicsMotionType.DYNAMIC);
    setPhysicsBodyShape(world, body, shape);
    setPhysicsShapeMaterial(world, shape, 0.2, 0);
    setPhysicsBodyMassProperties(world, body, { mass: 1 });
    showPhysicsBody(viewer, body);
}

function createHelper(parent: SceneNode, name: string, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): SceneNode {
    const helper = createTransformNode(name);
    helper.position.set(x, y, z);
    helper.rotation.set(rx, ry, rz);
    helper.parent = parent;
    parent.children.push(helper);
    return helper;
}

function addChildShape(world: PhysicsWorld, container: PhysicsShape, parent: SceneNode, child: PhysicsShape, helper: SceneNode): void {
    addPhysicsShapeChildFromParent(world, container, parent, child, helper);
    setPhysicsShapeMaterial(world, child, 0.2, 0);
}

function createAggregateShape(world: PhysicsWorld, root: SceneNode, kind: ShapeRow["name"]): PhysicsShape {
    const container = createPhysicsShape(world, { type: PhysicsShapeType.CONTAINER });
    if (kind === "skull") {
        const head = createHelper(root, "skull-head-helper", 0, 0.11, 0.05);
        addChildShape(world, container, root, createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { center: { x: 0, y: 0, z: 0 }, radius: 0.4 } }), head);
        const jaw = createHelper(root, "skull-jaw-helper", 0, -0.25, -0.3);
        addChildShape(
            world,
            container,
            root,
            createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center: { x: 0, y: 0, z: 0 }, extents: { x: 0.5, y: 0.4, z: 0.3 } } }),
            jaw
        );
    } else {
        const cyl1 = createHelper(root, "seagull-cyl1-helper", 0, 2.5, 0.28);
        addChildShape(
            world,
            container,
            root,
            createPhysicsShape(world, { type: PhysicsShapeType.CYLINDER, parameters: { pointA: { x: 0, y: -0.45, z: 0 }, pointB: { x: 0, y: 0.45, z: 0 }, radius: 0.35 } }),
            cyl1
        );
        const cyl2 = createHelper(root, "seagull-cyl2-helper", 0.01, 2.45, 0.9, Math.PI / 2);
        addChildShape(
            world,
            container,
            root,
            createPhysicsShape(world, { type: PhysicsShapeType.CYLINDER, parameters: { pointA: { x: 0, y: -0.25, z: 0 }, pointB: { x: 0, y: 0.25, z: 0 }, radius: 0.125 } }),
            cyl2
        );
        const body = createHelper(root, "seagull-body-helper", 0, 1.5, 0.1);
        addChildShape(world, container, root, createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { center: { x: 0, y: 0, z: 0 }, radius: 0.5 } }), body);
        const cyl3 = createHelper(root, "seagull-cyl3-helper", 0, 1.4, -0.7, Math.PI / 2);
        addChildShape(
            world,
            container,
            root,
            createPhysicsShape(world, { type: PhysicsShapeType.CYLINDER, parameters: { pointA: { x: 0, y: -0.35, z: 0 }, pointB: { x: 0, y: 0.35, z: 0 }, radius: 0.15 } }),
            cyl3
        );
        const cyl4 = createHelper(root, "seagull-cyl4-helper", 0, 0.55, 0.25);
        addChildShape(
            world,
            container,
            root,
            createPhysicsShape(world, { type: PhysicsShapeType.CYLINDER, parameters: { pointA: { x: 0, y: -0.55, z: 0 }, pointB: { x: 0, y: 0.55, z: 0 }, radius: 0.25 } }),
            cyl4
        );
    }
    return container;
}

function createShapeRow(world: PhysicsWorld, viewer: PhysicsViewer, row: ShapeRow): void {
    const meshBody = createVisualMesh(row, COLOR_MESH_SHAPE, 0, "mesh");
    addToScene(viewer.scene, meshBody);
    bindBodyShape(world, viewer, meshBody, createPhysicsShape(world, { type: PhysicsShapeType.MESH, mesh: meshBody }));

    const hullBody = createVisualMesh(row, COLOR_HULL_SHAPE, 2, "hull");
    addToScene(viewer.scene, hullBody);
    bindBodyShape(world, viewer, hullBody, createPhysicsShape(world, { type: PhysicsShapeType.CONVEX_HULL, mesh: hullBody }));

    const root = createTransformNode(`${row.name}-aggregate-root`);
    root.position.set(4, 2, row.z);
    const aggregateVisual = createVisualMesh(row, COLOR_AGGREGATE_SHAPE, 0, "aggregate-visual");
    aggregateVisual.position.set(0, 0, 0);
    aggregateVisual.material = createMaterial(COLOR_AGGREGATE_SHAPE);
    aggregateVisual.scaling.set(row.scale, row.scale, row.scale);
    aggregateVisual.parent = root;
    root.children.push(aggregateVisual);
    addToScene(viewer.scene, root);
    bindBodyShape(world, viewer, root, createAggregateShape(world, root, row.name));
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    scene.camera = createArcRotateCamera(-1.22, 1.28, 8, { x: 3.1, y: 1, z: 4.1 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

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
            window.setTimeout(() => {
                stopEngine(engine);
            }, 0);
        }
    });

    const rows = await loadShapeRows(engine);
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });
    const viewer = createPhysicsViewer(scene, world, { color: [1, 1, 1, 1] });

    const ground = createGround(engine, { width: 40, height: 40 });
    ground.material = createMaterial(COLOR_GROUND);
    addToScene(scene, ground);
    const groundShape = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { center: { x: 0, y: 0, z: 0 }, extents: { x: 40, y: 0.1, z: 40 } } });
    const groundBody = createPhysicsBody(world, ground, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, groundBody, groundShape);
    setPhysicsShapeMaterial(world, groundShape, 0.2, 0.3);
    showPhysicsBody(viewer, groundBody);

    for (const row of rows) {
        createShapeRow(world, viewer, row);
    }

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
