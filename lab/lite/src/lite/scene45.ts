// Scene 45: Physics collision filtering — port of playground #H4UR4Z#1

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    applyPhysicsBodyForce,
    createBox,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    onBeforeRender,
    PhysicsShapeType,
    registerScene,
    setPhysicsShapeFilterCollideMask,
    setPhysicsShapeFilterMembershipMask,
    startEngine,
    stopEngine,
} from "babylon-lite";

const PHYSICS_FPS = 60;
const FILTER_GROUP_SPHERE = 1;
const FILTER_GROUP_GROUND = 2;
const FILTER_GROUP_BOX = 4;

function readCaptureAfterFrames(): number | null {
    const value = new URLSearchParams(window.location.search).get("captureAfter");
    if (value === null) {
        return null;
    }
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * PHYSICS_FPS) : null;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    scene.camera = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    const sphereMat = createStandardMaterial();
    sphereMat.diffuseColor = [1, 1, 1];
    sphereMat.specularColor = [0.08, 0.08, 0.08];

    const sphere1 = createSphere(engine, { diameter: 2, segments: 32 });
    sphere1.position.set(1.5, 5, 0);
    sphere1.material = sphereMat;
    addToScene(scene, sphere1);

    const sphere2 = createSphere(engine, { diameter: 2, segments: 32 });
    sphere2.position.set(-1.5, 4, 0);
    sphere2.material = sphereMat;
    addToScene(scene, sphere2);

    const ground = createGround(engine, { width: 10, height: 10 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.5];
    ground.material = groundMat;
    addToScene(scene, ground);

    const box = createBox(engine, 1);
    box.scaling.set(8, 2, 2);
    const redMaterial = createStandardMaterial();
    redMaterial.diffuseColor = [1, 0, 0];
    redMaterial.specularColor = [0.08, 0.08, 0.08];
    box.material = redMaterial;
    addToScene(scene, box);

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

    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -1, z: 0 });

    const sphere1Aggregate = createPhysicsAggregate(world, sphere1, PhysicsShapeType.SPHERE, { mass: 1 });
    const sphere2Aggregate = createPhysicsAggregate(world, sphere2, PhysicsShapeType.SPHERE, { mass: 1 });
    const groundAggregate = createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });
    const boxAggregate = createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: 0, extents: { x: 8, y: 2, z: 2 } });

    applyPhysicsBodyForce(world, sphere1Aggregate.body, { x: sphere1.position.x, y: sphere1.position.y, z: sphere1.position.z }, { x: 0, y: 1, z: 5 });

    setPhysicsShapeFilterMembershipMask(world, sphere1Aggregate.shape, FILTER_GROUP_SPHERE);
    setPhysicsShapeFilterMembershipMask(world, sphere2Aggregate.shape, FILTER_GROUP_SPHERE);
    setPhysicsShapeFilterMembershipMask(world, groundAggregate.shape, FILTER_GROUP_GROUND);
    setPhysicsShapeFilterMembershipMask(world, boxAggregate.shape, FILTER_GROUP_BOX);

    setPhysicsShapeFilterCollideMask(world, sphere1Aggregate.shape, FILTER_GROUP_GROUND | FILTER_GROUP_BOX);
    setPhysicsShapeFilterCollideMask(world, sphere2Aggregate.shape, FILTER_GROUP_GROUND);

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
