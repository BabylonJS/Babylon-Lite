// Babylon.js reference — Scene 41: Physics V2 shape debug viewer (playground #LKPBW5)

import HavokPhysics from "@babylonjs/havok";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PhysicsViewer } from "@babylonjs/core/Debug/physicsViewer";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import {
    PhysicsShapeBox,
    PhysicsShapeContainer,
    PhysicsShapeConvexHull,
    PhysicsShapeCylinder,
    PhysicsShapeMesh,
    PhysicsShapeSphere,
} from "@babylonjs/core/Physics/v2/physicsShape";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/loaders/glTF/2.0";

const PHYSICS_FPS = 60;
const ASSET_BASE = "https://playground.babylonjs.com/scenes/";
const SKULL_ROW_Z = 1.5;
const SEAGULL_ROW_Z = 6.5;
const COLOR_MESH_SHAPE = Color3.FromHexString("#DB504A");
const COLOR_HULL_SHAPE = Color3.FromHexString("#E3B505");
const COLOR_AGGREGATE_SHAPE = Color3.FromHexString("#56A3A6");
const COLOR_GROUND = new Color3(0.52, 0.52, 0.52);

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

function findImportedMesh(meshes: readonly unknown[], label: string): Mesh {
    const mesh = meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (!mesh) {
        throw new Error(`Scene 41 could not find imported mesh for ${label}.`);
    }
    return mesh;
}

function cloneMesh(mesh: Mesh, name: string): Mesh {
    const clone = mesh.clone(name);
    if (!clone) {
        throw new Error(`Scene 41 could not clone mesh ${mesh.name}.`);
    }
    return clone;
}

function bindBodyShape(
    scene: Scene,
    viewer: PhysicsViewer,
    node: Mesh | TransformNode,
    shape: PhysicsShapeMesh | PhysicsShapeConvexHull | PhysicsShapeContainer,
    color: Color3
): void {
    const material = createMaterial(scene, color);
    if (node instanceof Mesh) {
        node.material = material;
    }
    for (const child of node.getChildMeshes()) {
        child.material = material;
    }

    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
    shape.material = { friction: 0.2, restitution: 0 };
    body.shape = shape;
    body.setMassProperties({ mass: 1 });
    viewer.showBody(body);
}

function createHelper(parent: TransformNode, name: string, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): TransformNode {
    const helper = new TransformNode(name, parent.getScene());
    helper.position.set(x, y, z);
    helper.rotation.set(rx, ry, rz);
    helper.parent = parent;
    return helper;
}

function createSkullAggregateShape(scene: Scene, root: TransformNode): PhysicsShapeContainer {
    const sphere = createHelper(root, "skull-head-helper", 0, 0.11, 0.05);
    const box = createHelper(root, "skull-jaw-helper", 0, -0.25, -0.3);
    const container = new PhysicsShapeContainer(scene);
    container.addChildFromParent(root, new PhysicsShapeSphere(Vector3.Zero(), 0.4, scene), sphere);
    container.addChildFromParent(root, new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(0.5, 0.4, 0.3), scene), box);
    container.material = { friction: 0.2, restitution: 0 };
    return container;
}

function createSeagullAggregateShape(scene: Scene, root: TransformNode): PhysicsShapeContainer {
    const cyl1 = createHelper(root, "seagull-cyl1-helper", 0, 2.5, 0.28);
    const cyl2 = createHelper(root, "seagull-cyl2-helper", 0.01, 2.45, 0.9, Math.PI / 2);
    const sph1 = createHelper(root, "seagull-body-helper", 0, 1.5, 0.1);
    const cyl3 = createHelper(root, "seagull-cyl3-helper", 0, 1.4, -0.7, Math.PI / 2);
    const cyl4 = createHelper(root, "seagull-cyl4-helper", 0, 0.55, 0.25);

    const container = new PhysicsShapeContainer(scene);
    container.addChildFromParent(root, new PhysicsShapeCylinder(new Vector3(0, -0.45, 0), new Vector3(0, 0.45, 0), 0.35, scene), cyl1);
    container.addChildFromParent(root, new PhysicsShapeCylinder(new Vector3(0, -0.25, 0), new Vector3(0, 0.25, 0), 0.125, scene), cyl2);
    container.addChildFromParent(root, new PhysicsShapeCylinder(new Vector3(0, -0.35, 0), new Vector3(0, 0.35, 0), 0.15, scene), cyl3);
    container.addChildFromParent(root, new PhysicsShapeCylinder(new Vector3(0, -0.55, 0), new Vector3(0, 0.55, 0), 0.25, scene), cyl4);
    container.addChildFromParent(root, new PhysicsShapeSphere(Vector3.Zero(), 0.5, scene), sph1);
    container.material = { friction: 0.2, restitution: 0 };
    return container;
}

async function createSkullRow(scene: Scene, viewer: PhysicsViewer, position: Vector3): Promise<void> {
    const result = await SceneLoader.ImportMeshAsync("", ASSET_BASE, "skull.babylon", scene);
    const meshBody = findImportedMesh(result.meshes, "skull");
    meshBody.position.set(0, 0, 0);
    meshBody.normalizeToUnitCube();

    const hullBody = cloneMesh(meshBody, "skull-hull");
    const aggregateVisual = cloneMesh(meshBody, "skull-aggregate-visual");
    const aggregateRoot = new TransformNode("skull-aggregate-root", scene);
    aggregateVisual.parent = aggregateRoot;

    meshBody.position.copyFrom(position);
    hullBody.position.copyFrom(position);
    hullBody.position.x += 2;
    aggregateRoot.position.copyFrom(position);
    aggregateRoot.position.x += 4;

    bindBodyShape(scene, viewer, meshBody, new PhysicsShapeMesh(meshBody, scene), COLOR_MESH_SHAPE);
    bindBodyShape(scene, viewer, hullBody, new PhysicsShapeConvexHull(hullBody, scene), COLOR_HULL_SHAPE);
    bindBodyShape(scene, viewer, aggregateRoot, createSkullAggregateShape(scene, aggregateRoot), COLOR_AGGREGATE_SHAPE);
}

async function createSeagullRow(scene: Scene, viewer: PhysicsViewer, position: Vector3): Promise<void> {
    const result = await SceneLoader.ImportMeshAsync("", ASSET_BASE, "seagulf.glb", scene);
    const meshBody = findImportedMesh(result.meshes, "seagull");
    meshBody.parent = null;
    meshBody.position.set(0, 0, 0);
    meshBody.normalizeToUnitCube();
    meshBody.scaling.scaleInPlace(3);

    const hullBody = cloneMesh(meshBody, "seagull-hull");
    const aggregateVisual = cloneMesh(meshBody, "seagull-aggregate-visual");
    const aggregateRoot = new TransformNode("seagull-aggregate-root", scene);
    aggregateVisual.parent = aggregateRoot;

    meshBody.position.copyFrom(position);
    hullBody.position.copyFrom(position);
    hullBody.position.x += 2;
    aggregateRoot.position.copyFrom(position);
    aggregateRoot.position.x += 4;

    bindBodyShape(scene, viewer, meshBody, new PhysicsShapeMesh(meshBody, scene), COLOR_MESH_SHAPE);
    bindBodyShape(scene, viewer, hullBody, new PhysicsShapeConvexHull(hullBody, scene), COLOR_HULL_SHAPE);
    bindBodyShape(scene, viewer, aggregateRoot, createSeagullAggregateShape(scene, aggregateRoot), COLOR_AGGREGATE_SHAPE);
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const captureAfterFrames = readCaptureAfterFrames();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("camera", -1.22, 1.28, 8, new Vector3(3.1, 1, 4.1), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const hk = new HavokPlugin(false, hknp);
    scene.enablePhysics(new Vector3(0, -10, 0), hk);

    const viewer = new PhysicsViewer(scene);

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
    ground.material = createMaterial(scene, COLOR_GROUND);
    const groundBody = new PhysicsBody(ground, PhysicsMotionType.STATIC, false, scene);
    const groundShape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(40, 0.1, 40), scene);
    groundShape.material = { friction: 0.2, restitution: 0.3 };
    groundBody.shape = groundShape;
    groundBody.setMassProperties({ mass: 0 });
    viewer.showBody(groundBody);

    await Promise.all([createSkullRow(scene, viewer, new Vector3(0, 2, SKULL_ROW_Z)), createSeagullRow(scene, viewer, new Vector3(0, 2, SEAGULL_ROW_Z))]);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });

    let ready = false;
    let simulatedFrames = 0;
    let captureQueued = false;
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        const now = performance.now();
        if (!ready) {
            ready = true;
            canvas.dataset.initMs = String(now - __initStart);
            canvas.dataset.ready = "true";
        } else {
            simulatedFrames++;
        }
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            canvas.dataset.captureReady = "true";
            window.setTimeout(() => {
                engine.stopRenderLoop();
            }, 0);
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
