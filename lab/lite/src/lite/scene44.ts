// Scene 44: Physics sleeping towers — port of playground #KJ0945#1.

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createGround,
    createHavokWorld,
    createHemisphericLight,
    createPhysicsAggregate,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    PhysicsShapeType,
    registerScene,
    startEngine,
    stopEngine,
} from "babylon-lite";

const PHYSICS_FPS = 60;
const DROP_AFTER_MS = 2_000;

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

function colorFor(index: number): [number, number, number] {
    const r = ((index * 73 + 41) & 255) / 255;
    const g = ((index * 151 + 89) & 255) / 255;
    const b = ((index * 211 + 157) & 255) / 255;
    return [r, g, b];
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 1000 / PHYSICS_FPS;
    const captureAfterFrames = readCaptureAfterFrames();

    scene.camera = createFreeCamera({ x: 0, y: 3, z: -15 }, { x: 0, y: 3, z: 0 });

    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);

    const ground = createGround(engine, { width: 10, height: 10 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.5, 0.5, 0.5];
    ground.material = groundMat;
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

    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, { mass: 0 });

    const createBoxes = (size: number, numBoxes: number, startAsleep: boolean, pos: { x: number; y: number; z: number }, yOffset: number, colorOffset: number): void => {
        for (let i = 0; i < numBoxes; i++) {
            const box = createBox(engine, size);
            const material = createStandardMaterial();
            material.diffuseColor = colorFor(colorOffset + i);
            material.specularColor = [0.08, 0.08, 0.08];
            box.material = material;
            box.position.set(pos.x, pos.y + i * (yOffset + size) + 0.5, pos.z);
            addToScene(scene, box);
            createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: 1, startAsleep });
        }
    };

    createBoxes(1, 3, true, { x: -2, y: 0, z: 0 }, 0.5, 0);
    createBoxes(1, 3, false, { x: 2, y: 0, z: 0 }, 0.5, 10);

    window.setTimeout(() => {
        createBoxes(0.2, 1, false, { x: -2, y: 5, z: 0 }, 0, 20);
        createBoxes(0.2, 1, false, { x: 2, y: 5, z: 0 }, 0, 21);
    }, DROP_AFTER_MS);

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
