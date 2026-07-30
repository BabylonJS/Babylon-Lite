// Babylon.js reference — Scene 47: Physics V2 heightfield with two falling rows of shapes.
//
// Mirrors the Lite scene47: a static heightfield body from heightMap.png plus
// Row 1 (PhysicsAggregate, all types) and Row 2 (PhysicsBody + PhysicsShape, all types).
// CONVEX_HULL and MESH use the seagull glb.

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { GroundMesh } from "@babylonjs/core/Meshes/groundMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import {
    PhysicsShapeBox,
    PhysicsShapeCapsule,
    PhysicsShapeConvexHull,
    PhysicsShapeCylinder,
    PhysicsShapeGroundMesh,
    PhysicsShapeMesh,
    PhysicsShapeSphere,
} from "@babylonjs/core/Physics/v2/physicsShape";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/loaders/glTF/2.0";

const PHYSICS_FPS = 60;
const HEIGHTMAP_URL = "https://playground.babylonjs.com/textures/heightMap.png";
const ASSET_BASE = "https://playground.babylonjs.com/scenes/";
const DROP_HEIGHT = 18;
const ROW1_Z = -5;
const ROW2_Z = 5;
const FRICTION = 0.5;
const RESTITUTION = 0.1;

const COLOR_BOX = new Color3(0.85, 0.27, 0.29);
const COLOR_SPHERE = new Color3(0.89, 0.71, 0.02);
const COLOR_CAPSULE = new Color3(0.34, 0.64, 0.65);
const COLOR_CYLINDER = new Color3(0.45, 0.55, 0.85);
const COLOR_HULL = new Color3(0.55, 0.78, 0.25);
const COLOR_MESH = new Color3(0.78, 0.36, 0.7);
const COLOR_GROUND = new Color3(0.52, 0.52, 0.52);

interface ShapeParams {
    center?: Vector3;
    extents?: Vector3;
    radius?: number;
    pointA?: Vector3;
    pointB?: Vector3;
}

const BOX_PARAMS: ShapeParams = { center: Vector3.Zero(), extents: new Vector3(2, 2, 2) };
const SPHERE_PARAMS: ShapeParams = { center: Vector3.Zero(), radius: 1 };
const CAPSULE_PARAMS: ShapeParams = { pointA: new Vector3(0, -0.75, 0), pointB: new Vector3(0, 0.75, 0), radius: 0.75 };
const CYLINDER_PARAMS: ShapeParams = { pointA: new Vector3(0, -1.5, 0), pointB: new Vector3(0, 1.5, 0), radius: 1 };

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

function createMaterial(scene: Scene, color: Color3): StandardMaterial {
    const material = new StandardMaterial("m", scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.backFaceCulling = false;
    return material;
}

function findImportedMesh(meshes: readonly unknown[]): Mesh {
    const mesh = meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (!mesh) {
        throw new Error("Scene 47 could not find imported seagull mesh.");
    }
    return mesh;
}

function paramsFor(type: PhysicsShapeType): ShapeParams {
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

function createPrimitiveVisual(scene: Scene, type: PhysicsShapeType, color: Color3): Mesh {
    let mesh: Mesh;
    switch (type) {
        case PhysicsShapeType.BOX:
            mesh = MeshBuilder.CreateBox("box", { size: 2 }, scene);
            break;
        case PhysicsShapeType.SPHERE:
            mesh = MeshBuilder.CreateSphere("sphere", { diameter: 2, segments: 24 }, scene);
            break;
        case PhysicsShapeType.CAPSULE:
            mesh = MeshBuilder.CreateCapsule("capsule", { height: 3, radius: 0.75, tessellation: 24 }, scene);
            break;
        case PhysicsShapeType.CYLINDER:
        default:
            mesh = MeshBuilder.CreateCylinder("cylinder", { diameter: 2, height: 3, tessellation: 24 }, scene);
            break;
    }
    mesh.material = createMaterial(scene, color);
    return mesh;
}

function makePrimitiveShape(scene: Scene, type: PhysicsShapeType): PhysicsShape {
    const p = paramsFor(type);
    switch (type) {
        case PhysicsShapeType.BOX:
            return new PhysicsShapeBox(p.center!, Quaternion.Identity(), p.extents!, scene);
        case PhysicsShapeType.SPHERE:
            return new PhysicsShapeSphere(p.center!, p.radius!, scene);
        case PhysicsShapeType.CAPSULE:
            return new PhysicsShapeCapsule(p.pointA!, p.pointB!, p.radius!, scene);
        case PhysicsShapeType.CYLINDER:
        default:
            return new PhysicsShapeCylinder(p.pointA!, p.pointB!, p.radius!, scene);
    }
}

function rowXPositions(count: number, spacing: number): number[] {
    const xs: number[] = [];
    const start = -((count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) {
        xs.push(start + i * spacing);
    }
    return xs;
}

interface RowEntry {
    type: PhysicsShapeType;
    color: Color3;
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

function createGroundFromHeightMapAsync(scene: Scene): Promise<GroundMesh> {
    return new Promise<GroundMesh>((resolve) => {
        const ground = MeshBuilder.CreateGroundFromHeightMap(
            "ground",
            HEIGHTMAP_URL,
            { width: 100, height: 100, subdivisions: 100, minHeight: 0, maxHeight: 10, onReady: () => resolve(ground) },
            scene
        );
    });
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, 1.05, 48, new Vector3(0, 4, 0), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    const ground = await createGroundFromHeightMapAsync(scene);
    ground.material = createMaterial(scene, COLOR_GROUND);

    const seagullResult = await SceneLoader.ImportMeshAsync("", ASSET_BASE, "seagulf.glb", scene);
    const seagull = findImportedMesh(seagullResult.meshes);
    seagull.parent = null;
    seagull.position.set(0, 0, 0);
    seagull.normalizeToUnitCube();
    seagull.scaling.scaleInPlace(3);
    seagull.setEnabled(false);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, hknp);
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);
    // Start paused (fixed step 0): physics does not advance until the PhysicsViewer wireframe
    // overlay is fully rendered (its utility-layer materials compile asynchronously and are blank
    // on the first frames). MUST be set AFTER enablePhysics — the PhysicsEngine constructor resets
    // the plugin time step to 1/60. See the readiness gate in the render loop below.
    hk.setTimeStep(0);

    const viewer = new PhysicsViewer(scene);

    // Static heightfield body from the ground mesh / heightMap.png.
    const groundShape = new PhysicsShapeGroundMesh(ground, scene);
    groundShape.material = { friction: FRICTION, restitution: RESTITUTION };
    const groundBody = new PhysicsBody(ground, PhysicsMotionType.STATIC, false, scene);
    groundBody.shape = groundShape;
    groundBody.setMassProperties({ mass: 0 });
    viewer.showBody(groundBody);

    // Row 1 — aggregates (primitives + seagull convex-hull and mesh aggregates).
    const row1X = rowXPositions(ROW1.length, 6);
    ROW1.forEach((entry, i) => {
        if (entry.type === PhysicsShapeType.CONVEX_HULL || entry.type === PhysicsShapeType.MESH) {
            const clone = seagull.clone(`seagull-r1-${i}`, null)!;
            clone.setEnabled(true);
            clone.position.set(row1X[i]!, DROP_HEIGHT, ROW1_Z);
            clone.material = createMaterial(scene, entry.color);
            // Build the mesh/convex-hull shape explicitly (the same way Row 2 does)
            // and pass the PRE-BUILT shape into the aggregate. PhysicsAggregate adopts
            // a PhysicsShape instance verbatim, bypassing _addSizeOptions()'s auto-center
            // (which otherwise offsets the seagull body from its visual mesh). This keeps
            // it an aggregate while matching Lite/Row 2 placement exactly.
            const shape = entry.type === PhysicsShapeType.CONVEX_HULL ? new PhysicsShapeConvexHull(clone, scene) : new PhysicsShapeMesh(clone, scene);
            const aggregate = new PhysicsAggregate(clone, shape, { mass: 1, friction: FRICTION, restitution: RESTITUTION }, scene);
            viewer.showBody(aggregate.body);
            return;
        }
        const mesh = createPrimitiveVisual(scene, entry.type, entry.color);
        mesh.position.set(row1X[i]!, DROP_HEIGHT, ROW1_Z);
        const p = paramsFor(entry.type);
        const aggregate = new PhysicsAggregate(
            mesh,
            entry.type,
            { mass: 1, friction: FRICTION, restitution: RESTITUTION, center: p.center, extents: p.extents, radius: p.radius, pointA: p.pointA, pointB: p.pointB },
            scene
        );
        viewer.showBody(aggregate.body);
    });

    // Row 2 — body + shape (all shape types).
    const row2X = rowXPositions(ROW2.length, 6);
    ROW2.forEach((entry, i) => {
        let mesh: Mesh;
        let shape: PhysicsShape;
        if (entry.type === PhysicsShapeType.CONVEX_HULL || entry.type === PhysicsShapeType.MESH) {
            const clone = seagull.clone(`seagull-${i}`, null)!;
            clone.setEnabled(true);
            clone.position.set(row2X[i]!, DROP_HEIGHT, ROW2_Z);
            clone.material = createMaterial(scene, entry.color);
            mesh = clone;
            shape = entry.type === PhysicsShapeType.CONVEX_HULL ? new PhysicsShapeConvexHull(clone, scene) : new PhysicsShapeMesh(clone, scene);
        } else {
            mesh = createPrimitiveVisual(scene, entry.type, entry.color);
            mesh.position.set(row2X[i]!, DROP_HEIGHT, ROW2_Z);
            shape = makePrimitiveShape(scene, entry.type);
        }
        const body = new PhysicsBody(mesh, PhysicsMotionType.DYNAMIC, false, scene);
        shape.material = { friction: FRICTION, restitution: RESTITUTION };
        body.shape = shape;
        body.setMassProperties({ mass: 1 });
        viewer.showBody(body);
    });

    const eng = engine as any;
    let ready = false;
    let physicsRunning = false;
    let physStep = 0;
    let captureQueued = false;

    // The PhysicsViewer renders its wireframes through the default utility layer, whose WebGPU
    // pipelines compile asynchronously — so the overlay is blank for the first few frames. Gate the
    // start of the simulation on every utility-layer wireframe mesh being ready, then step physics
    // and count ACTUAL steps. This makes the parity capture independent of GPU warm-up timing.
    const utilityScene = UtilityLayerRenderer.DefaultUtilityLayer.utilityLayerScene;
    const wireframeReady = (): boolean => {
        const meshes = utilityScene.meshes;
        if (meshes.length === 0) {
            return false;
        }
        for (const m of meshes) {
            if (m.isEnabled() && !m.isReady(true)) {
                return false;
            }
        }
        return true;
    };

    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
        if (!physicsRunning && wireframeReady()) {
            physicsRunning = true;
            hk.setTimeStep(1 / PHYSICS_FPS);
        }
    });

    scene.onAfterPhysicsObservable.add(() => {
        if (!physicsRunning) {
            return;
        }
        physStep++;
        if (captureAfterFrames !== null && !captureQueued && physStep >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => engine.stopRenderLoop(), 0);
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
})().catch(console.error);
