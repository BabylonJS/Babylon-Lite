// Scene 102: Physics V2 — Havok raycast with collision filtering (port of PG #PY59V9#7).
//
// Two static MESH boxes with different filter membership masks (1 and 2), a ground, and a
// ray from (0,1,-2) to (0.8,1,6). A filtered raycast (collideWith=2) is performed after the
// broadphase is built; it only hits box2 (membership 2). The hit point, distance, and triangle
// index are logged to the console (the playground used on-screen GUI text instead) and written
// to canvas.dataset.rayResult so the parity test can assert Lite and BJS compute the same values.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createGround,
    createEngine,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    createTube,
    onBeforeRender,
    onPhysicsAfterStep,
    physicsRaycast,
    PhysicsMotionType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyShape,
    setPhysicsShapeFilterMembershipMask,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, SceneContext } from "babylon-lite";

const PHYSICS_FPS = 60;
const CAPTURE_DEFAULT_FRAME = 5;
const COLLIDE_WITH = 2;

const RAY_ORIGIN = { x: 0, y: 1, z: -2 };
const RAY_DIR = { x: 0.1, y: 0, z: 1 };
const RAY_LEN = 8;
const RAY_DEST = { x: RAY_ORIGIN.x + RAY_DIR.x * RAY_LEN, y: RAY_ORIGIN.y + RAY_DIR.y * RAY_LEN, z: RAY_ORIGIN.z + RAY_DIR.z * RAY_LEN };

function readCaptureFrame(): number {
    const params = new URLSearchParams(window.location.search);
    const frameValue = params.get("captureFrame");
    if (frameValue !== null) {
        const frame = Number(frameValue);
        return Number.isFinite(frame) && frame >= 0 ? Math.round(frame) : CAPTURE_DEFAULT_FRAME;
    }
    return CAPTURE_DEFAULT_FRAME;
}

function makeMaterial(color: [number, number, number]) {
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.specularColor = [0, 0, 0];
    return material;
}

function makeSphere(engine: EngineContext, scene: SceneContext, position: { x: number; y: number; z: number }, color: [number, number, number]): Mesh {
    const sphere = createSphere(engine, { diameter: 0.2, segments: 32 });
    sphere.material = makeMaterial(color);
    sphere.position.set(position.x, position.y, position.z);
    addToScene(scene, sphere);
    return sphere;
}

function addFilteredMeshBox(engine: EngineContext, scene: SceneContext, world: ReturnType<typeof createHavokWorld>, z: number, color: [number, number, number], membership: number): void {
    const box = createBox(engine, 2);
    box.material = makeMaterial(color);
    box.position.set(0, 1, z);
    addToScene(scene, box);

    const shape = createPhysicsShape(world, { type: PhysicsShapeType.MESH, mesh: box });
    setPhysicsShapeFilterMembershipMask(world, shape, membership);
    const body = createPhysicsBody(world, box, PhysicsMotionType.STATIC);
    setPhysicsBodyShape(world, body, shape);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureFrame = readCaptureFrame();

    scene.camera = createArcRotateCamera(-0.5, Math.PI / 3, 20, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    addToScene(scene, light);

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -10, z: 0 });

    // Two static MESH boxes with distinct filter membership masks.
    addFilteredMeshBox(engine, scene, world, 1, [0.38, 0.75, 0.91], 1);
    addFilteredMeshBox(engine, scene, world, 4, [0.38, 0.91, 0.46], 2);

    // Ground.
    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = makeMaterial([0.2, 0.2, 0.2]);
    addToScene(scene, ground);
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

    // Ray visual: yellow tube + green origin sphere + red destination sphere.
    const rayTube = createTube(engine, { path: [RAY_ORIGIN, RAY_DEST], radius: 0.03, tessellation: 8 });
    const rayMat = makeMaterial([1, 1, 0]);
    rayMat.disableLighting = true;
    rayMat.emissiveColor = [1, 1, 0];
    rayTube.material = rayMat;
    addToScene(scene, rayTube);
    makeSphere(engine, scene, RAY_ORIGIN, [0, 1, 0]);
    makeSphere(engine, scene, RAY_DEST, [1, 0, 0]);

    // Yellow sphere placed at the raycast hit point (created once the raycast runs).
    const hitMarker = makeSphere(engine, scene, RAY_ORIGIN, [1, 1, 0]);
    hitMarker.visible = false;

    let steps = 0;
    let raycastDone = false;
    let captureQueued = false;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    // Run the filtered raycast after the first physics step has built the broadphase.
    onPhysicsAfterStep(world, () => {
        steps++;
        if (!raycastDone) {
            raycastDone = true;
            const result = physicsRaycast(world, RAY_ORIGIN, RAY_DEST, { collideWith: COLLIDE_WITH });
            // eslint-disable-next-line no-console
            console.log("scene102 raycast", {
                collideWith: COLLIDE_WITH,
                hasHit: result.hasHit,
                hitPoint: result.hitPoint,
                hitDistance: result.hitDistance,
                triangleIndex: result.triangleIndex,
            });
            if (result.hasHit) {
                hitMarker.position.set(result.hitPoint.x, result.hitPoint.y, result.hitPoint.z);
                hitMarker.visible = true;
            }
            canvas.dataset.rayResult = JSON.stringify({
                hasHit: result.hasHit,
                hitPoint: { x: round(result.hitPoint.x), y: round(result.hitPoint.y), z: round(result.hitPoint.z) },
                hitDistance: round(result.hitDistance),
                triangleIndex: result.triangleIndex,
            });
        }
        if (!captureQueued && steps >= captureFrame) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

main().catch((err) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = err instanceof Error ? err.message : String(err);
    }
    console.error(err);
});
