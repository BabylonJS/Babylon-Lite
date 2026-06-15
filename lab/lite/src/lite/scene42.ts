// Scene 42: Physics clone pre-step — port of playground #MZCQC4

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    cloneTransformNode,
    onBeforeRender,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyPreStep,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const PHYSICS_FPS = 60;

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

    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.specularColor = [0.08, 0.08, 0.08];

    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.position.set(-2, 4, 0);
    sphere.material = material;
    addToScene(scene, sphere);

    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = material;
    addToScene(scene, ground);

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

    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        radius: 1,
    });

    const sphere2 = cloneTransformNode(sphere) as Mesh;
    sphere2.name = "sphereClone";
    sphere2.material = material;
    addToScene(scene, sphere2);
    const sphere2Aggregate = createPhysicsAggregate(world, sphere2, PhysicsShapeType.SPHERE, {
        mass: 1,
        radius: 1,
    });
    setPhysicsBodyPreStep(sphere2Aggregate.body, true);
    sphere2.position.x = 2;

    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
    });

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
