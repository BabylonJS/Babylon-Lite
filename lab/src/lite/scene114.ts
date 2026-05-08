// Scene 114 — Morph/Skeleton Picking
// Visualizes GPU and detailed picks on geometry whose rendered positions differ
// from bind pose. Markers are derived from actual pick results.

import type { EngineContext, Mesh, PickingInfo, SceneContext } from "babylon-lite";
import type { EngineContextInternal } from "babylon-lite/engine/engine.js";
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGpuPicker,
    createHemisphericLight,
    createMorphTargets,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    disposePicker,
    enableDetailedPicking,
    pickAsync,
    registerScene,
    startEngine,
} from "babylon-lite";
import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";

type ColorTuple = [number, number, number];
type Vec3Tuple = [number, number, number];

const MORPH_DELTA_X = 1.35;
const SKELETON_DELTA_X = 1.45;

function createUnlitPbr(engine: EngineContext, color: ColorTuple) {
    return createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, color[0], color[1], color[2]),
        ormTexture: createSolidTexture2D(engine, 1, 1, 0),
        unlit: true,
        unlitColor: color,
        metallicFactor: 0,
        roughnessFactor: 1,
        directIntensity: 0,
        environmentIntensity: 0,
        doubleSided: true,
    });
}

function createQuadMesh(engine: EngineContext, name: string, color: ColorTuple): Mesh {
    const positions = new Float32Array([-0.55, -0.46, 0, 0.55, -0.46, 0, -0.55, 0.46, 0, 0.55, 0.46, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const mesh = createMeshFromData(engine as EngineContextInternal, name, positions, normals, indices, uvs);
    mesh.name = name;
    mesh.material = createUnlitPbr(engine, color);
    return mesh;
}

function createMorphedQuad(engine: EngineContext): Mesh {
    const mesh = createQuadMesh(engine, "scene114-morph-target", [0, 1, 1]);
    mesh.position.set(-1.65, 0.42, 0);

    const deltas = new Float32Array(4 * 3);
    for (let i = 0; i < 4; i++) {
        deltas[i * 3] = MORPH_DELTA_X;
    }
    mesh.morphTargets = Object.assign(createMorphTargets(engine as EngineContextInternal, [{ positions: deltas, normals: null }], 4, [1]), {
        targets: [{ positions: deltas, normals: null }],
        weights: new Float32Array([1, 0, 0, 0]),
    });
    return mesh;
}

function createSkinnedQuad(engine: EngineContext): Mesh {
    const mesh = createQuadMesh(engine, "scene114-skeleton-target", [1, 0, 0]);
    mesh.position.set(0.72, -0.42, 0);

    const joints = new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const boneData = new Float32Array(32);
    boneData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    boneData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, SKELETON_DELTA_X, 0, 0, 1], 16);
    mesh.skeleton = Object.assign(createSkeleton(engine as EngineContextInternal, joints, weights, 2, boneData), {
        joints,
        weights,
        boneMatrices: boneData,
        joints1: null,
        weights1: null,
    });
    return mesh;
}

function createMarker(engine: EngineContext, name: string, color: ColorTuple): Mesh {
    const marker = createBox(engine, 1);
    marker.name = name;
    marker.material = createUnlitPbr(engine, color);
    marker.position.set(0, -100, 0);
    marker.scaling.set(0.12, 0.12, 0.12);
    return marker;
}

function createHelperBox(engine: EngineContext, name: string, color: ColorTuple, position: Vec3Tuple, scaling: Vec3Tuple, rotationZ = 0): Mesh {
    const box = createBox(engine, 1);
    box.name = name;
    box.material = createUnlitPbr(engine, color);
    box.position.set(position[0], position[1], position[2]);
    box.scaling.set(scaling[0], scaling[1], scaling[2]);
    box.rotation.z = rotationZ;
    return box;
}

function snapMarkerCoord(value: number): number {
    // The marker is a visual locator for the real pick; snapping avoids subpixel edge drift between engines.
    return Math.round(value * 8) / 8;
}

function addConceptHelpers(scene: SceneContext, engine: EngineContext): void {
    const morphGhost = createQuadMesh(engine, "scene114-morph-bind-ghost", [0, 0, 1]);
    morphGhost.position.set(-1.65, 0.42, 0.16);
    addToScene(scene, morphGhost);

    addToScene(scene, createHelperBox(engine, "scene114-morph-displacement-rail-a", [0, 1, 1], [-0.98, 1.05, -0.08], [1.16, 0.025, 0.025]));
    addToScene(scene, createHelperBox(engine, "scene114-morph-displacement-rail-b", [0, 1, 1], [-0.98, 0.84, -0.08], [1.16, 0.025, 0.025]));
    addToScene(scene, createHelperBox(engine, "scene114-morph-arrow-tip", [0, 1, 1], [-0.36, 0.945, -0.08], [0.13, 0.13, 0.035], Math.PI / 4));

    const skeletonGhost = createQuadMesh(engine, "scene114-skeleton-bind-ghost", [1, 0, 0]);
    skeletonGhost.position.set(0.72, -0.42, 0.16);
    addToScene(scene, skeletonGhost);

    addToScene(scene, createHelperBox(engine, "scene114-root-bone-rail", [0, 0, 1], [0.17, -0.42, -0.08], [0.035, 1.05, 0.035]));
    addToScene(scene, createHelperBox(engine, "scene114-shift-bone-rail", [1, 1, 0], [2.72, -0.42, -0.08], [0.035, 1.05, 0.035]));
    addToScene(scene, createHelperBox(engine, "scene114-skeleton-bone-shift-rail", [1, 1, 0], [1.445, 0.18, -0.08], [2.55, 0.025, 0.025]));
    addToScene(scene, createHelperBox(engine, "scene114-skeleton-bone-shift-tip", [1, 1, 0], [2.76, 0.18, -0.08], [0.12, 0.12, 0.035], Math.PI / 4));

    addToScene(scene, createHelperBox(engine, "scene114-root-influence-bottom", [0, 0, 1], [0.17, -0.88, -0.12], [0.1, 0.1, 0.1]));
    addToScene(scene, createHelperBox(engine, "scene114-root-influence-top", [0, 0, 1], [0.17, 0.04, -0.12], [0.1, 0.1, 0.1]));
    addToScene(scene, createHelperBox(engine, "scene114-shift-influence-bottom", [1, 1, 0], [2.72, -0.88, -0.12], [0.1, 0.1, 0.1]));
    addToScene(scene, createHelperBox(engine, "scene114-shift-influence-top", [1, 1, 0], [2.72, 0.04, -0.12], [0.1, 0.1, 0.1]));
}

function placeGpuMarker(info: PickingInfo, marker: Mesh): void {
    if (!info.hit || !info.pickedPoint) {
        return;
    }
    const [x, y, z] = info.pickedPoint;
    marker.position.set(snapMarkerCoord(x), snapMarkerCoord(y), snapMarkerCoord(z - 0.09));
    marker.scaling.set(0.14, 0.14, 0.14);
}

function placeDetailedMarker(info: PickingInfo, marker: Mesh): void {
    if (!info.hit || !info.pickedPoint) {
        return;
    }
    const [x, y, z] = info.pickedPoint;
    marker.position.set(snapMarkerCoord(x), snapMarkerCoord(y), snapMarkerCoord(z - 0.16));
    marker.scaling.set(0.12, 0.12, 0.12);
}

async function pickInRegion(
    scene: SceneContext,
    canvas: HTMLCanvasElement,
    targetName: string,
    minFx: number,
    maxFx: number,
    minFy: number,
    maxFy: number,
    detailed: boolean
): Promise<PickingInfo> {
    const picker = createGpuPicker(scene);
    if (detailed) {
        enableDetailedPicking(picker);
    }
    const stepsX = 16;
    const stepsY = 12;
    const centerX = stepsX / 2;
    const centerY = stepsY / 2;
    for (let r = 0; r <= Math.max(centerX, centerY); r++) {
        for (let y = 0; y <= stepsY; y++) {
            for (let x = 0; x <= stepsX; x++) {
                if (Math.max(Math.abs(x - centerX), Math.abs(y - centerY)) !== r) {
                    continue;
                }
                const fx = minFx + ((maxFx - minFx) * x) / stepsX;
                const fy = minFy + ((maxFy - minFy) * y) / stepsY;
                const info = await pickAsync(picker, canvas.clientWidth * fx, canvas.clientHeight * fy);
                if (info.hit && info.pickedMesh?.name === targetName) {
                    disposePicker(picker);
                    return info;
                }
            }
        }
    }
    disposePicker(picker);
    return { hit: false, pickedMesh: null, pickedPoint: null, distance: 0, faceId: -1, bu: 0, bv: 0, subMeshId: 0, thinInstanceIndex: -1, ray: null };
}

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.145, g: 0.165, b: 0.21, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5.5, { x: 0.15, y: 0, z: 0 });
    camera.fov = 0.72;
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    addToScene(scene, createMorphedQuad(engine));
    addToScene(scene, createSkinnedQuad(engine));
    addConceptHelpers(scene, engine);

    const morphGpuMarker = createMarker(engine, "scene114-morph-gpu-marker", [1, 0, 1]);
    const morphDetailedMarker = createMarker(engine, "scene114-morph-detailed-marker", [0, 1, 0]);
    const skeletonGpuMarker = createMarker(engine, "scene114-skeleton-gpu-marker", [1, 1, 0]);
    const skeletonDetailedMarker = createMarker(engine, "scene114-skeleton-detailed-marker", [0, 0, 1]);
    addToScene(scene, morphGpuMarker);
    addToScene(scene, morphDetailedMarker);
    addToScene(scene, skeletonGpuMarker);
    addToScene(scene, skeletonDetailedMarker);

    await registerScene(engine, scene);
    await startEngine(engine);
    await waitFrames(4);

    const morphGpuInfo = await pickInRegion(scene, canvas, "scene114-morph-target", 0.39, 0.55, 0.34, 0.48, false);
    placeGpuMarker(morphGpuInfo, morphGpuMarker);

    const morphDetailedInfo = await pickInRegion(scene, canvas, "scene114-morph-target", 0.43, 0.58, 0.34, 0.48, true);
    placeDetailedMarker(morphDetailedInfo, morphDetailedMarker);

    const skeletonGpuInfo = await pickInRegion(scene, canvas, "scene114-skeleton-target", 0.7, 0.88, 0.52, 0.66, false);
    placeGpuMarker(skeletonGpuInfo, skeletonGpuMarker);

    const skeletonDetailedInfo = await pickInRegion(scene, canvas, "scene114-skeleton-target", 0.74, 0.92, 0.52, 0.66, true);
    placeDetailedMarker(skeletonDetailedInfo, skeletonDetailedMarker);

    await waitFrames(4);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.morphGpuHit = morphGpuInfo.hit ? (morphGpuInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.morphDetailedHit = morphDetailedInfo.hit ? (morphDetailedInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.skeletonGpuHit = skeletonGpuInfo.hit ? (skeletonGpuInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.skeletonDetailedHit = skeletonDetailedInfo.hit ? (skeletonDetailedInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.morphDetailedFace = String(morphDetailedInfo.faceId);
    canvas.dataset.skeletonDetailedFace = String(skeletonDetailedInfo.faceId);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
