// Babylon.js reference for Scene 115: Alien Picking at Frame 100.

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { IMeshDataOptions } from "@babylonjs/core/Meshes/abstractMesh";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Culling/ray";
import "@babylonjs/loaders/glTF";

type BjsPickingInfo = NonNullable<ReturnType<Scene["pick"]>>;

const DEFAULT_SEEK_TIME = 100 / 60;
const PICK_TARGET_X_RATIO = 0.51;
const PICK_TARGET_Y_RATIO = 0.51;
const VISUAL_PICK_GRID = 0.02;
const SURFACE_MARKER_OFFSET = 0.03;
const NORMAL_MARKER_OFFSET = 0.3;

interface PickMarkerState {
    markerPlaced: boolean;
    normalMarkerPlaced: boolean;
    normalMarkerAligned: boolean;
    markerNearPick: boolean;
    normalMarkerNearPick: boolean;
    point: Vector3 | null;
    normal: Vector3 | null;
}

function createUnlitMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.White();
    material.emissiveColor = color;
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    return material;
}

function normalizeVector(v: Vector3): Vector3 {
    if (v.lengthSquared() < 1e-8) {
        return new Vector3(0, 0, -1);
    }
    return v.normalize();
}

function snapPickPoint(point: Vector3): Vector3 {
    return new Vector3(
        Math.round(point.x / VISUAL_PICK_GRID) * VISUAL_PICK_GRID,
        Math.round(point.y / VISUAL_PICK_GRID) * VISUAL_PICK_GRID,
        Math.round(point.z / VISUAL_PICK_GRID) * VISUAL_PICK_GRID
    );
}

function computeNormalBasisQuaternion(normal: Vector3): Quaternion {
    const yAxis = normalizeVector(normal.clone());
    const reference = Math.abs(yAxis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const xAxis = normalizeVector(Vector3.Cross(reference, yAxis));
    const zAxis = Vector3.Cross(xAxis, yAxis);

    const m00 = xAxis.x;
    const m01 = yAxis.x;
    const m02 = zAxis.x;
    const m10 = xAxis.y;
    const m11 = yAxis.y;
    const m12 = zAxis.y;
    const m20 = xAxis.z;
    const m21 = yAxis.z;
    const m22 = zAxis.z;
    const trace = m00 + m11 + m22;

    let qx: number;
    let qy: number;
    let qz: number;
    let qw: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        qw = 0.25 * s;
        qx = (m21 - m12) / s;
        qy = (m02 - m20) / s;
        qz = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        qw = (m21 - m12) / s;
        qx = 0.25 * s;
        qy = (m01 + m10) / s;
        qz = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        qw = (m02 - m20) / s;
        qx = (m01 + m10) / s;
        qy = 0.25 * s;
        qz = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        qw = (m10 - m01) / s;
        qx = (m02 + m20) / s;
        qy = (m12 + m21) / s;
        qz = 0.25 * s;
    }

    return new Quaternion(qx, qy, qz, qw).normalize();
}

function rotateLocalYAxis(q: Quaternion): Vector3 {
    const x = q.x;
    const y = q.y;
    const z = q.z;
    const w = q.w;
    return new Vector3(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
}

function createMarkerSphere(scene: Scene): AbstractMesh {
    const marker = MeshBuilder.CreateSphere("scene115-surface-marker", { segments: 16, diameter: 0.055 }, scene);
    marker.material = createUnlitMaterial(scene, "scene115-surface-marker-mat", new Color3(1, 0.14, 0.86));
    marker.position.set(0, -100, 0);
    marker.isPickable = false;
    return marker;
}

function createNormalMarker(scene: Scene): AbstractMesh {
    const marker = MeshBuilder.CreateBox("scene115-normal-marker", { size: 1 }, scene);
    marker.material = createUnlitMaterial(scene, "scene115-normal-marker-mat", new Color3(0.05, 0.95, 1));
    marker.position.set(0, -100, 0);
    marker.scaling.set(0.026, 0.28, 0.026);
    marker.isPickable = false;
    return marker;
}

function markerNearPick(marker: AbstractMesh, point: Vector3, maxDistanceSquared: number): boolean {
    return Vector3.DistanceSquared(marker.position, point) < maxDistanceSquared;
}

function formatVector(value: Vector3 | null): string {
    return value ? [value.x, value.y, value.z].map((v) => v.toPrecision(12)).join(",") : "";
}

function placeMarkers(info: BjsPickingInfo | null, surfaceMarker: AbstractMesh, normalMarker: AbstractMesh): PickMarkerState {
    if (!info?.hit || !info.pickedPoint) {
        return { markerPlaced: false, normalMarkerPlaced: false, normalMarkerAligned: false, markerNearPick: false, normalMarkerNearPick: false, point: null, normal: null };
    }

    const point = info.pickedPoint;
    const visualPoint = snapPickPoint(point);
    const normal = normalizeVector(info.getNormal(true, true) ?? visualPoint.clone());
    surfaceMarker.position.copyFrom(visualPoint.add(normal.scale(SURFACE_MARKER_OFFSET)));

    normalMarker.position.copyFrom(visualPoint.add(normal.scale(NORMAL_MARKER_OFFSET)));
    normalMarker.rotationQuaternion = computeNormalBasisQuaternion(normal);

    const alignedAxis = rotateLocalYAxis(normalMarker.rotationQuaternion);
    const normalMarkerAligned = Vector3.Dot(alignedAxis, normal) > 0.999;

    return {
        markerPlaced: true,
        normalMarkerPlaced: true,
        normalMarkerAligned,
        markerNearPick: markerNearPick(surfaceMarker, point, 0.002),
        normalMarkerNearPick: markerNearPick(normalMarker, point, 0.16),
        point,
        normal,
    };
}

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

function getSeekFrame(): number {
    const params = new URLSearchParams(window.location.search);
    const seekTime = parseFloat(params.get("seekTime") || String(DEFAULT_SEEK_TIME));
    return (Number.isFinite(seekTime) && seekTime > 0 ? seekTime : DEFAULT_SEEK_TIME) * 60;
}

function getPickRatios(): [number, number] {
    const params = new URLSearchParams(window.location.search);
    const pickX = parseFloat(params.get("pickX") || "");
    const pickY = parseFloat(params.get("pickY") || "");
    return [Number.isFinite(pickX) ? pickX : PICK_TARGET_X_RATIO, Number.isFinite(pickY) ? pickY : PICK_TARGET_Y_RATIO];
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.7;
    await SceneLoader.ImportMeshAsync("", "https://playground.babylonjs.com/scenes/Alien/", "Alien.gltf", scene);

    const camera = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2, 2, new Vector3(0, 0, 0), scene);
    scene.activeCamera = camera;

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const surfaceMarker = createMarkerSphere(scene);
    const normalMarker = createNormalMarker(scene);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame(): void; current: number } };
    const seekFrame = getSeekFrame();
    let frameCount = 0;
    let seekDone = false;
    let resolveFrozen!: () => void;
    const frozen = new Promise<void>((resolve) => {
        resolveFrozen = resolve;
    });
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        if (frameCount === 10 && !seekDone) {
            scene.animationGroups.forEach((group) => {
                const range = group.to - group.from;
                group.goToFrame(range > 0 ? group.from + ((seekFrame - group.from) % range) : seekFrame);
            });
            scene.animatables.forEach((animatable) => animatable.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
            canvas.dataset.seekFrame = seekFrame.toPrecision(12);
            resolveFrozen();
        }
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    await frozen;
    const deformedPickOptions = { applySkeleton: true, applyMorph: true, updatePositionsArray: true } satisfies IMeshDataOptions;
    scene.meshes.forEach((mesh) => {
        mesh.refreshBoundingInfo(deformedPickOptions);
    });
    await waitFrames(4);

    const [pickXRatio, pickYRatio] = getPickRatios();
    const pickX = canvas.clientWidth * pickXRatio;
    const pickY = canvas.clientHeight * pickYRatio;
    const pickInfo = scene.pick(pickX, pickY, (mesh) => !mesh.name.startsWith("scene115-"), false, camera);
    const state = placeMarkers(pickInfo, surfaceMarker, normalMarker);

    await waitFrames(4);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickCss = `${pickX.toPrecision(12)},${pickY.toPrecision(12)}`;
    canvas.dataset.pickedHit = pickInfo?.hit ? (pickInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.pickPoint = formatVector(state.point);
    canvas.dataset.pickNormal = formatVector(state.normal);
    canvas.dataset.pickFaceId = String(pickInfo?.faceId ?? -1);
    canvas.dataset.pickSubMeshFaceId = String(pickInfo?.subMeshFaceId ?? -1);
    canvas.dataset.pickSubMeshId = String(pickInfo?.subMeshId ?? -1);
    canvas.dataset.pickBu = (pickInfo?.bu ?? 0).toPrecision(12);
    canvas.dataset.pickBv = (pickInfo?.bv ?? 0).toPrecision(12);
    canvas.dataset.pickDistance = (pickInfo?.distance ?? 0).toPrecision(12);
    canvas.dataset.markerPlaced = String(state.markerPlaced);
    canvas.dataset.normalMarkerPlaced = String(state.normalMarkerPlaced);
    canvas.dataset.normalMarkerAligned = String(state.normalMarkerAligned);
    canvas.dataset.markerNearPick = String(state.markerNearPick);
    canvas.dataset.normalMarkerNearPick = String(state.normalMarkerNearPick);
    canvas.dataset.ready = "true";
})().catch(console.error);
