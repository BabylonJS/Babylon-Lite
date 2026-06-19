// Scene 103: Physics V2 — thin-instanced wall + raycast instance picking (port of PG #I6AR8X).
//
// A wall of thin-instanced cylinders. A physics raycast from a camera-relative origin into the
// wall returns WHICH instance was hit. The parity test fires a fixed set of deterministic rays and
// asserts Lite and Babylon.js report the SAME hit instance index for every ray.
//
// DEVIATIONS from the playground (intentional, for a deterministic parity test):
//   • Moderate instance count (10×6×3 = 180) instead of the playground's 3000 — fast + deterministic.
//   • Blocks are STATIC (mass 0). The playground uses dynamic mass-1 blocks that fall chaotically,
//     which would make the raycast-instance result non-deterministic. Static blocks never move, so
//     the same ray hits the same instance index in both engines — that is the parity guarantee.
//   • Per-instance colors use a fixed-seed LCG (identical in both engines) instead of Math.random().
//
// INSTANCE-INDEX RESOLUTION:
//   • BJS: a PhysicsAggregate(baseBlock, BOX, { mass: 0 }) on a thin-instanced mesh auto-creates one
//     body per instance; the raycast result's `bodyIndex` IS the thin-instance index.
//   • Lite: has no thin-instance physics, so we build one STATIC per-instance BOX body (same i-order
//     as the thin-instance matrix buffer, index = i + j*W + k*W*H) and map body→instance. The raycast
//     returns the hit `body`; we look up its instance index. Geometrically identical boxes at identical
//     transforms ⇒ the same ray hits the same instance index in both engines.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCylinder,
    createEngine,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTransformNode,
    getCameraPosition,
    getViewProjectionMatrix,
    mat4Invert,
    onBeforeRender,
    onPhysicsAfterStep,
    physicsRaycast,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyShape,
    setThinInstanceColors,
    setThinInstances,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mat4, PhysicsBody, Vec3 } from "babylon-lite";

const PHYSICS_FPS = 60;
const CAPTURE_DEFAULT_FRAME = 5;

const WALL_W = 10;
const WALL_H = 6;
const WALL_D = 3;
const BLOCK_SIZE = 2;
const TOTAL = WALL_W * WALL_H * WALL_D;

const CAM_ALPHA = Math.PI / 2;
const CAM_BETA = Math.PI / 2.4;
const CAM_RADIUS = 38;
const CAM_TARGET: Vec3 = { x: -1, y: 5, z: -1 };

// Fixed deterministic raycast targets (i, j, k) on the wall — different instances.
const RAY_TARGETS: ReadonlyArray<readonly [number, number, number]> = [
    [5, 3, 2],
    [2, 1, 2],
    [8, 5, 2],
    [0, 0, 2],
    [9, 2, 2],
    [4, 4, 2],
];

interface RayHit {
    hasHit: boolean;
    instance: number;
    point: { x: number; y: number; z: number };
}

function readCaptureFrame(): number | null {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_DEFAULT_FRAME;
    }
    return null;
}

/** Small LCG so per-instance colors match Lite ↔ BJS exactly. */
function rand(seed: { value: number }): number {
    seed.value = (seed.value * 1664525 + 1013904223) >>> 0;
    return seed.value / 0x100000000;
}

/** Instance (i,j,k) world position — identical layout to the playground. */
function instancePos(i: number, j: number, k: number): Vec3 {
    return { x: (i - WALL_W / 2) * BLOCK_SIZE, y: j * BLOCK_SIZE + BLOCK_SIZE / 2, z: (k - WALL_D / 2) * BLOCK_SIZE };
}

/** ArcRotate camera world position (BJS convention) — the ray origin is relative to this. */
function arcCameraPosition(): Vec3 {
    return {
        x: CAM_TARGET.x + CAM_RADIUS * Math.cos(CAM_ALPHA) * Math.sin(CAM_BETA),
        y: CAM_TARGET.y + CAM_RADIUS * Math.cos(CAM_BETA),
        z: CAM_TARGET.z + CAM_RADIUS * Math.sin(CAM_ALPHA) * Math.sin(CAM_BETA),
    };
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

function setTranslation(matrix: Float32Array, offset: number, x: number, y: number, z: number): void {
    matrix[offset] = 1;
    matrix[offset + 5] = 1;
    matrix[offset + 10] = 1;
    matrix[offset + 12] = x;
    matrix[offset + 13] = y;
    matrix[offset + 14] = z;
    matrix[offset + 15] = 1;
}

/** Unproject a screen pixel to a world point on the far plane (column-major Mat4). */
function unprojectFar(invVp: Mat4, ndcX: number, ndcY: number): Vec3 {
    const x = ndcX;
    const y = ndcY;
    const z = 1;
    const wx = invVp[0]! * x + invVp[4]! * y + invVp[8]! * z + invVp[12]!;
    const wy = invVp[1]! * x + invVp[5]! * y + invVp[9]! * z + invVp[13]!;
    const wz = invVp[2]! * x + invVp[6]! * y + invVp[10]! * z + invVp[14]!;
    const ww = invVp[3]! * x + invVp[7]! * y + invVp[11]! * z + invVp[15]!;
    return { x: wx / ww, y: wy / ww, z: wz / ww };
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureFrame = readCaptureFrame();
    const autoTest = captureFrame !== null;

    const camera = createArcRotateCamera(CAM_ALPHA, CAM_BETA, CAM_RADIUS, CAM_TARGET);
    scene.camera = camera;
    if (!autoTest) {
        attachControl(camera, canvas, scene);
    }

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.81, z: 0 });

    // Ground.
    const ground = createGround(engine, { width: WALL_W * BLOCK_SIZE * 4, height: WALL_D * BLOCK_SIZE * 6 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.3, 0.3, 0.3];
    groundMat.specularColor = [0, 0, 0];
    ground.material = groundMat;
    ground.pickable = false;
    addToScene(scene, ground);
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

    // Thin-instanced wall (visual).
    const baseBlock = createCylinder(engine, { diameter: BLOCK_SIZE, height: BLOCK_SIZE, subdivisions: 10, tessellation: 48 });
    const baseMat = createStandardMaterial();
    baseMat.diffuseColor = [1, 1, 1];
    baseMat.specularColor = [0, 0, 0];
    baseBlock.material = baseMat;

    const matrixBuffer = new Float32Array(TOTAL * 16);
    const colorBuffer = new Float32Array(TOTAL * 4);
    const seed = { value: 0x10_3a_5c };

    // Per-instance STATIC BOX body, built in the SAME i-order as the thin-instance index so
    // body→instance lines up with BJS's auto-created per-instance bodyIndex.
    // BOX extents are full sizes (max-min); the cylinder's bounding box is BLOCK_SIZE on every axis.
    const blockExtents: Vec3 = { x: BLOCK_SIZE, y: BLOCK_SIZE, z: BLOCK_SIZE };
    const bodyToInstance = new Map<PhysicsBody, number>();

    for (let i = 0; i < WALL_W; i++) {
        for (let j = 0; j < WALL_H; j++) {
            for (let k = 0; k < WALL_D; k++) {
                const index = i + j * WALL_W + k * WALL_W * WALL_H;
                const p = instancePos(i, j, k);
                setTranslation(matrixBuffer, index * 16, p.x, p.y, p.z);
                colorBuffer[index * 4] = rand(seed);
                colorBuffer[index * 4 + 1] = rand(seed);
                colorBuffer[index * 4 + 2] = rand(seed);
                colorBuffer[index * 4 + 3] = 1;

                const node = createTransformNode(`block${index}`, p.x, p.y, p.z, 0, 0, 0, 1);
                const shape = createPhysicsShape(world, { type: PhysicsShapeType.BOX, parameters: { extents: blockExtents } });
                const body = createPhysicsBody(world, node, PhysicsMotionType.STATIC);
                setPhysicsBodyShape(world, body, shape);
                bodyToInstance.set(body, index);
            }
        }
    }
    setThinInstances(baseBlock, matrixBuffer, TOTAL);
    setThinInstanceColors(baseBlock, colorBuffer);
    addToScene(scene, baseBlock);

    // Green indicator sphere placed at a raycast hit point.
    const indicator = createSphere(engine, { diameter: 2, segments: 24 });
    const indicatorMat = createStandardMaterial();
    indicatorMat.diffuseColor = [0, 1, 0];
    indicatorMat.emissiveColor = [0, 1, 0];
    indicatorMat.specularColor = [0, 0, 0];
    indicatorMat.alpha = 0.7;
    indicator.material = indicatorMat;
    indicator.pickable = false;
    indicator.visible = false;
    addToScene(scene, indicator);

    const camOrigin = arcCameraPosition();

    function castInto(target: Vec3): RayHit {
        const result = physicsRaycast(world, camOrigin, target);
        const instance = result.hasHit && result.body ? (bodyToInstance.get(result.body) ?? -1) : -1;
        return { hasHit: result.hasHit, instance, point: { x: round(result.hitPoint.x), y: round(result.hitPoint.y), z: round(result.hitPoint.z) } };
    }

    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    if (autoTest) {
        // Automatic test mode: fixed deterministic rays, freeze for the screenshot.
        let steps = 0;
        let raysDone = false;
        let captureQueued = false;
        onPhysicsAfterStep(world, () => {
            steps++;
            if (!raysDone) {
                raysDone = true;
                const hits: RayHit[] = [];
                for (const [i, j, k] of RAY_TARGETS) {
                    hits.push(castInto(instancePos(i, j, k)));
                }
                const last = hits[hits.length - 1]!;
                if (last.hasHit) {
                    indicator.position.set(last.point.x, last.point.y, last.point.z);
                    indicator.visible = true;
                }
                canvas.dataset.rayHits = JSON.stringify(hits);
                // eslint-disable-next-line no-console
                console.log("scene103 rayHits", hits);
            }
            if (!captureQueued && steps >= captureFrame!) {
                captureQueued = true;
                window.setTimeout(() => {
                    canvas.dataset.captureReady = "true";
                    stopEngine(engine);
                }, 0);
            }
        });
    } else {
        // Interactive mode: click sets the raycast DESTINATION; origin is the camera position.
        canvas.addEventListener("pointerdown", (evt) => {
            const rect = canvas.getBoundingClientRect();
            const ndcX = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
            const ndcY = 1 - ((evt.clientY - rect.top) / rect.height) * 2;
            const vp = getViewProjectionMatrix(camera, rect.width / rect.height);
            const invVp = mat4Invert(vp);
            if (!invVp) {
                return;
            }
            const camPos = getCameraPosition(camera);
            const far = unprojectFar(invVp, ndcX, ndcY);
            const dir = { x: far.x - camPos.x, y: far.y - camPos.y, z: far.z - camPos.z };
            const dest = { x: camPos.x + dir.x * 1000, y: camPos.y + dir.y * 1000, z: camPos.z + dir.z * 1000 };
            const result = physicsRaycast(world, camPos, dest);
            if (result.hasHit) {
                indicator.position.set(result.hitPoint.x, result.hitPoint.y, result.hitPoint.z);
                indicator.visible = true;
            }
        });
    }

    await registerScene(scene);
    await startEngine(engine);
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
