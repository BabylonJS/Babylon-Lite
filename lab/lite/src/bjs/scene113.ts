// Babylon.js reference for Scene 113: Picking Precision.

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Culling/ray";

type BjsPickingInfo = NonNullable<ReturnType<Scene["pick"]>>;

const PICK_TARGET_X_RATIO = 0.625;
const PICK_TARGET_Y_RATIO = 0.625;

interface PickMarkerState {
    markerPlaced: boolean;
    normalMarkerPlaced: boolean;
    normalMarkerAligned: boolean;
    markerNearPick: boolean;
    normalMarkerNearPick: boolean;
    point: Vector3 | null;
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
    const marker = MeshBuilder.CreateSphere("scene113-surface-marker", { segments: 16, diameter: 0.14 }, scene);
    marker.material = createUnlitMaterial(scene, "surface-marker-mat", new Color3(1, 0.18, 0.82));
    marker.position.set(0, -4, 0);
    marker.isPickable = false;
    return marker;
}

function createNormalMarker(scene: Scene): AbstractMesh {
    const marker = MeshBuilder.CreateBox("scene113-normal-marker", { size: 1 }, scene);
    marker.material = createUnlitMaterial(scene, "normal-marker-mat", new Color3(0.12, 0.92, 1));
    marker.position.set(0, -4, 0);
    marker.scaling.set(0.055, 0.48, 0.055);
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
        return { markerPlaced: false, normalMarkerPlaced: false, normalMarkerAligned: false, markerNearPick: false, normalMarkerNearPick: false, point: null };
    }

    const point = info.pickedPoint;
    const normal = normalizeVector(info.getNormal(false, true) ?? new Vector3(0, 0, -1));
    surfaceMarker.position.copyFrom(point);

    normalMarker.position.copyFrom(point.add(normal.scale(0.38)));
    normalMarker.rotationQuaternion = computeNormalBasisQuaternion(normal);

    const alignedAxis = rotateLocalYAxis(normalMarker.rotationQuaternion);
    const normalMarkerAligned = Vector3.Dot(alignedAxis, normal) > 0.999;

    return {
        markerPlaced: true,
        normalMarkerPlaced: true,
        normalMarkerAligned,
        markerNearPick: markerNearPick(surfaceMarker, point, 1e-8),
        normalMarkerNearPick: markerNearPick(normalMarker, point, 0.2),
        point,
    };
}

async function waitFrames(frameCount: number): Promise<void> {
    for (let i = 0; i < frameCount; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.28, 4.2, Vector3.Zero(), scene);
    camera.fov = 0.74;
    scene.activeCamera = camera;

    const sphere = MeshBuilder.CreateSphere("scene113-picked-sphere", { segments: 32, diameter: 1.8 }, scene);
    sphere.material = createUnlitMaterial(scene, "picked-sphere-mat", new Color3(0.18, 0.48, 0.95));

    const surfaceMarker = createMarkerSphere(scene);
    const normalMarker = createNormalMarker(scene);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame(): void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    await waitFrames(4);

    const pickInfo = scene.pick(canvas.clientWidth * PICK_TARGET_X_RATIO, canvas.clientHeight * PICK_TARGET_Y_RATIO, (mesh) => mesh === sphere, false, camera);
    const state = placeMarkers(pickInfo, surfaceMarker, normalMarker);

    await waitFrames(4);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickedHit = pickInfo?.hit ? pickInfo.pickedMesh?.name ?? "" : "miss";
    canvas.dataset.pickPoint = formatVector(state.point);
    canvas.dataset.markerPlaced = String(state.markerPlaced);
    canvas.dataset.normalMarkerPlaced = String(state.normalMarkerPlaced);
    canvas.dataset.normalMarkerAligned = String(state.normalMarkerAligned);
    canvas.dataset.markerNearPick = String(state.markerNearPick);
    canvas.dataset.normalMarkerNearPick = String(state.normalMarkerNearPick);
    canvas.dataset.ready = "true";
})().catch(console.error);
