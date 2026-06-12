// Scene 115 - Alien Picking at Frame 100
// Freezes the animated Alien at frame 100, performs one detailed pick, and
// moves visible markers to the picked point and picked normal for visual parity.

import type { EngineContext, Mesh, PickingInfo, Vec3Tuple } from "babylon-lite";
import {
    addToScene,
    createBox,
    createDefaultCamera,
    createEngine,
    createGpuPicker,
    createHemisphericLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    disposePicker,
    enableDetailedPicking,
    getPickedNormal,
    goToFrame,
    loadGltf,
    normalizeVec3,
    onBeforeRender,
    pauseAnimation,
    pickAsync,
    registerScene,
    startEngine,
} from "babylon-lite";

type ColorTuple = [number, number, number];
type QuatTuple = [number, number, number, number];

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
    point: Vec3Tuple | null;
    normal: Vec3Tuple | null;
}

function createUnlitMaterial(color: ColorTuple) {
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = color;
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    return material;
}

function snapPickPoint(point: Vec3Tuple): Vec3Tuple {
    return [
        Math.round(point[0] / VISUAL_PICK_GRID) * VISUAL_PICK_GRID,
        Math.round(point[1] / VISUAL_PICK_GRID) * VISUAL_PICK_GRID,
        Math.round(point[2] / VISUAL_PICK_GRID) * VISUAL_PICK_GRID,
    ];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function computeNormalBasisQuaternion(normal: Vec3Tuple): QuatTuple {
    const yAxis = normalizeVec3(normal[0], normal[1], normal[2], 1e-8);
    const reference: Vec3Tuple = Math.abs(yAxis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const xBasis = cross(reference, yAxis);
    const xAxis = normalizeVec3(xBasis[0], xBasis[1], xBasis[2], 1e-8);
    const zAxis = cross(xAxis, yAxis);

    const m00 = xAxis[0];
    const m01 = yAxis[0];
    const m02 = zAxis[0];
    const m10 = xAxis[1];
    const m11 = yAxis[1];
    const m12 = zAxis[1];
    const m20 = xAxis[2];
    const m21 = yAxis[2];
    const m22 = zAxis[2];
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

    const len = Math.hypot(qx, qy, qz, qw);
    return len < 1e-8 ? [0, 0, 0, 1] : [qx / len, qy / len, qz / len, qw / len];
}

function rotateLocalYAxis(q: QuatTuple): Vec3Tuple {
    const [x, y, z, w] = q;
    return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function createMarkerSphere(engine: EngineContext): Mesh {
    const marker = createSphere(engine, { segments: 16, diameter: 0.055 });
    marker.name = "scene115-surface-marker";
    marker.material = createUnlitMaterial([1, 0.14, 0.86]);
    marker.position.set(0, -100, 0);
    return marker;
}

function createNormalMarker(engine: EngineContext): Mesh {
    const marker = createBox(engine, 1);
    marker.name = "scene115-normal-marker";
    marker.material = createUnlitMaterial([0.05, 0.95, 1]);
    marker.position.set(0, -100, 0);
    marker.scaling.set(0.026, 0.28, 0.026);
    return marker;
}

function markerNearPick(marker: Mesh, point: Vec3Tuple, maxDistanceSquared: number): boolean {
    const dx = marker.position.x - point[0];
    const dy = marker.position.y - point[1];
    const dz = marker.position.z - point[2];
    return dx * dx + dy * dy + dz * dz < maxDistanceSquared;
}

function formatVec3(value: Vec3Tuple | null): string {
    return value ? value.map((v) => v.toPrecision(12)).join(",") : "";
}

function placeMarkers(info: PickingInfo, surfaceMarker: Mesh, normalMarker: Mesh): PickMarkerState {
    if (!info.hit || !info.pickedPoint) {
        return { markerPlaced: false, normalMarkerPlaced: false, normalMarkerAligned: false, markerNearPick: false, normalMarkerNearPick: false, point: null, normal: null };
    }

    const point = info.pickedPoint;
    const visualPoint = snapPickPoint(point);
    const normal = getPickedNormal(info, true) ?? normalizeVec3(visualPoint[0], visualPoint[1], visualPoint[2], 1e-8);
    surfaceMarker.position.set(visualPoint[0] + normal[0] * SURFACE_MARKER_OFFSET, visualPoint[1] + normal[1] * SURFACE_MARKER_OFFSET, visualPoint[2] + normal[2] * SURFACE_MARKER_OFFSET);

    normalMarker.position.set(visualPoint[0] + normal[0] * NORMAL_MARKER_OFFSET, visualPoint[1] + normal[1] * NORMAL_MARKER_OFFSET, visualPoint[2] + normal[2] * NORMAL_MARKER_OFFSET);
    const q = computeNormalBasisQuaternion(normal);
    normalMarker.rotationQuaternion.set(q[0], q[1], q[2], q[3]);

    const alignedAxis = rotateLocalYAxis(q);
    return {
        markerPlaced: true,
        normalMarkerPlaced: true,
        normalMarkerAligned: dot(alignedAxis, normal) > 0.999,
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

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1 };

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/Alien/Alien.gltf"));

    const cam = createDefaultCamera(scene);
    cam.alpha = Math.PI / 2;
    cam.beta = Math.PI / 2;
    cam.radius = 2;
    cam.target = { x: 0, y: 0, z: 0 };
    cam.nearPlane = 1;
    cam.farPlane = 10000;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    scene.fixedDeltaMs = 16.0;

    const seekFrame = getSeekFrame();
    let frameCount = 0;
    let seekDone = false;
    let resolveFrozen!: () => void;
    const frozen = new Promise<void>((resolve) => {
        resolveFrozen = resolve;
    });
    onBeforeRender(scene, () => {
        frameCount++;
        if (frameCount === 10 && !seekDone) {
            for (const group of scene.animationGroups) {
                goToFrame(group, seekFrame);
                pauseAnimation(group);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
            canvas.dataset.seekFrame = seekFrame.toPrecision(12);
            resolveFrozen();
        }
    });

    const surfaceMarker = createMarkerSphere(engine);
    const normalMarker = createNormalMarker(engine);
    addToScene(scene, surfaceMarker);
    addToScene(scene, normalMarker);

    await registerScene(scene);
    await startEngine(engine);
    await frozen;
    await waitFrames(4);

    const picker = createGpuPicker(scene);
    enableDetailedPicking(picker);
    const [pickXRatio, pickYRatio] = getPickRatios();
    const pickX = canvas.clientWidth * pickXRatio;
    const pickY = canvas.clientHeight * pickYRatio;
    const pickInfo = await pickAsync(picker, pickX, pickY);
    const state = placeMarkers(pickInfo, surfaceMarker, normalMarker);
    disposePicker(picker);

    await waitFrames(4);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickCss = `${pickX.toPrecision(12)},${pickY.toPrecision(12)}`;
    canvas.dataset.pickedHit = pickInfo.hit ? (pickInfo.pickedMesh?.name ?? "") : "miss";
    canvas.dataset.pickPoint = formatVec3(state.point);
    canvas.dataset.pickNormal = formatVec3(state.normal);
    canvas.dataset.pickFaceId = String(pickInfo.faceId);
    canvas.dataset.pickSubMeshFaceId = String(pickInfo.faceId);
    canvas.dataset.pickSubMeshId = "0";
    canvas.dataset.pickBu = pickInfo.bu.toPrecision(12);
    canvas.dataset.pickBv = pickInfo.bv.toPrecision(12);
    canvas.dataset.pickDistance = pickInfo.distance.toPrecision(12);
    canvas.dataset.markerPlaced = String(state.markerPlaced);
    canvas.dataset.normalMarkerPlaced = String(state.normalMarkerPlaced);
    canvas.dataset.normalMarkerAligned = String(state.normalMarkerAligned);
    canvas.dataset.markerNearPick = String(state.markerNearPick);
    canvas.dataset.normalMarkerNearPick = String(state.normalMarkerNearPick);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
