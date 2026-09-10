// Scene 306: Physics V2 — Nodes with parent tranforms

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
    createPhysicsViewer,
    createSceneContext,
    createStandardMaterial,
    createTransformNode,
    enableMirroredMeshes,
    eulerXYZToQuatTuple,
    onBeforeRender,
    onPhysicsAfterStep,
    PhysicsBody,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    registerScene,
    setPhysicsBodyMotionType,
    setPhysicsBodyPreStep,
    setPhysicsBodyPrestepType,
    showPhysicsBody,
    startEngine,
    stopEngine,
} from "babylon-lite";

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

    // Camera — FreeCamera at (-2, 8, -16) targeting origin
    scene.camera = createFreeCamera({ x: -2, y: 8, z: -16 }, { x: 0, y: 0, z: 0 });

    // Hemispheric light — intensity 0.7
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    // Ground — 16x16
    const ground = createGround(engine, { width: 16, height: 16 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    // Per-frame draw-call readout for the harness.
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
    });

    let simulatedFrames = 0;
    let captureQueued = false;

    // Havok physics — gravity (0, -9.8, 0)
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // Static ground
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
        friction: 0.6,
    });

    // cube material
    const cubeMat = createStandardMaterial();

    // dynamic cube1 without parent
    const cube1 = createBox(engine, 1);
    cube1.material = cubeMat;
    cube1.position.set(-6, 3, 0);
    addToScene(scene, cube1);
    createPhysicsAggregate(world, cube1, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });

    // dynamic cube2 with offset parent
    const parent2 = createTransformNode("parent2", -4, 3, 0);
    const rotQ = eulerXYZToQuatTuple(0, (20 * Math.PI) / 180, 0);
    parent2.rotationQuaternion.set(rotQ[0], rotQ[1], rotQ[2], rotQ[3]);
    addToScene(scene, parent2);
    const cube2 = createBox(engine, 1);
    cube2.material = cubeMat;
    cube2.parent = parent2;
    parent2.children.push(cube2);
    addToScene(scene, cube2);
    createPhysicsAggregate(world, cube2, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });

    // dynamic cube3 with simulated glTF root
    const root = createTransformNode("root");
    root.scaling.x = -1;
    addToScene(scene, root);
    const cube3 = createBox(engine, 1);
    cube3.position.set(-2, 3, 0);
    const rotQ2 = eulerXYZToQuatTuple(0, (40 * Math.PI) / 180, 0);
    cube3.rotationQuaternion.set(rotQ2[0], rotQ2[1], rotQ2[2], rotQ2[3]);
    cube3.material = cubeMat;
    cube3.parent = root;
    root.children.push(cube3);
    addToScene(scene, cube3);
    createPhysicsAggregate(world, cube3, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });

    // dynamic cube4 with offset parents and pre-step
    const parent4a = createTransformNode("parent4a");
    addToScene(scene, parent4a);
    const parent4b = createTransformNode("parent4b", 2, 3, 0);
    parent4b.parent = parent4a;
    parent4a.children.push(parent4b);
    addToScene(scene, parent4b);
    const cube4 = createBox(engine, 1);
    cube4.material = cubeMat;
    cube4.parent = parent4b;
    parent4b.children.push(cube4);
    addToScene(scene, cube4);
    const agg4 = createPhysicsAggregate(world, cube4, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });
    setPhysicsBodyPreStep(agg4.body, true);

    const parent5a = createTransformNode("parent5a");
    addToScene(scene, parent5a);
    const parent5b = createTransformNode("parent5b", 4, 2, 0);
    parent5b.parent = parent5a;
    parent5a.children.push(parent5b);
    addToScene(scene, parent5b);
    const cube5 = createBox(engine, 1);
    cube5.material = cubeMat;
    cube5.parent = parent5b;
    parent5b.children.push(cube5);
    addToScene(scene, cube5);
    const agg5 = createPhysicsAggregate(world, cube5, PhysicsShapeType.BOX, { mass: 1, friction: 0.5, restitution: 0.1 });
    setPhysicsBodyPreStep(agg5.body, false);
    setPhysicsBodyPrestepType(agg5.body, PhysicsPrestepType.ACTION);
    setPhysicsBodyMotionType(world, agg5.body, PhysicsMotionType.ANIMATED);

    // physics debug viewer
    const physViewer = createPhysicsViewer(scene, world, { color: [1, 1, 1, 1] });
    const bodies = (world as any)._bodies as PhysicsBody[];
    for (const body of bodies) {
        showPhysicsBody(physViewer, body);
    }

    // Count ACTUAL physics steps (not render frames) so the parity capture lands on the
    // same fixed 1/60 step as the BJS reference. onPhysicsAfterStep fires exactly once per
    // Havok step (after the body→node sync, before render), mirroring BJS onAfterPhysics.
    onPhysicsAfterStep(world, () => {
        simulatedFrames++;
        if (captureAfterFrames !== null && !captureQueued && simulatedFrames >= captureAfterFrames) {
            captureQueued = true;
            window.setTimeout(() => {
                canvas.dataset.captureReady = "true";
                stopEngine(engine);
            }, 0);
        }

        if (!captureQueued) {
            // update animated parents
            parent4a.position.z = Math.sin((simulatedFrames * Math.PI) / 180);
            const rotQ4 = eulerXYZToQuatTuple(0, (simulatedFrames * Math.PI) / 180, 0);
            parent4b.rotationQuaternion.set(rotQ4[0], rotQ4[1], rotQ4[2], rotQ4[3]);

            parent5a.position.y = Math.sin((simulatedFrames * Math.PI) / 180);
        }
    });

    await enableMirroredMeshes(scene);
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
