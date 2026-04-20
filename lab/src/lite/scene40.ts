// Scene 40: Physics V2 — Havok sphere drop (matches playground #Z8HTUN#1)

import HavokPhysics from "@babylonjs/havok";
import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createFreeCamera,
    createHemisphericLight,
    createSphere,
    createGround,
    createStandardMaterial,
    onBeforeRender,
    createHavokWorld,
    createPhysicsAggregate,
    PhysicsShapeType,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera — FreeCamera at (0, 5, -10) targeting origin
    scene.camera = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });

    // Hemispheric light — intensity 0.7
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.7;
    addToScene(scene, light);

    // Sphere — diameter 2, starts at y=4 (will drop via physics)
    const sphere = createSphere(engine, { diameter: 2, segments: 32 });
    sphere.material = createStandardMaterial();
    sphere.position.set(0, 4, 0);
    addToScene(scene, sphere);

    // Ground — 10x10
    const ground = createGround(engine, { width: 10, height: 10 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    // Havok physics — gravity (0, -9.8, 0)
    const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
    const world = createHavokWorld(scene, hknp, { x: 0, y: -9.8, z: 0 });

    // Dynamic sphere: mass=1, restitution=0.75
    createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, {
        mass: 1,
        restitution: 0.75,
    });

    // Static ground
    createPhysicsAggregate(world, ground, PhysicsShapeType.BOX, {
        mass: 0,
    });

    // Wait for sphere to settle (y ≈ 1.0 for 30 consecutive frames)
    let settleFrames = 0;
    onBeforeRender(scene, () => {
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        const y = sphere.position.y;
        if (Math.abs(y - 1.0) < 0.05) {
            settleFrames++;
            if (settleFrames > 30) {
                canvas.dataset.initMs = String(performance.now() - __initStart);
                canvas.dataset.ready = "true";
            }
        } else {
            settleFrames = 0;
        }
    });

    await startEngine(engine, scene);
}

main().catch(console.error);
