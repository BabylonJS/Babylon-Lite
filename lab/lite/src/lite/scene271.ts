// Scene 271: Shadow Light Rebuild — the scene is built with spot light A, renders, then swaps to
// spot light B (opposite side) with its own PCF shadow generator and rebuilds in place.
// The Babylon.js reference renders the FINAL configuration (light B) directly, so a correct
// rebuild must produce the same image. Geometry/materials mirror scene18 (spotlight hard shadows).

import {
    addToScene,
    removeFromScene,
    startEngine,
    createEngine,
    createSceneContext,
    createFreeCamera,
    createSpotLight,
    createGround,
    createBox,
    createStandardMaterial,
    createPcfSpotlightShadowGenerator,
    setShadowTaskCasterMeshes,
    attachFreeControl,
    registerSceneWithShadowSupport,
    rebuildSceneRenderables,
    unregisterScene,
} from "babylon-lite";

const nextFrame = async (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createFreeCamera({ x: 0, y: 10, z: -20 }, { x: 0, y: 0, z: 0 });
    cam.nearPlane = 1;
    cam.farPlane = 10000;
    scene.camera = cam;
    attachFreeControl(cam, canvas, scene);

    const ground = createGround(engine, { width: 24, height: 60 });
    const groundMat = createStandardMaterial();
    // Flat colour rather than a texture: this scene is graded at a strict MAD, and mip/anisotropy choices
    // on a textured ground differ slightly between GPUs, which would drown the signal we actually test.
    groundMat.diffuseColor = [0.75, 0.72, 0.66];
    groundMat.specularColor = [0, 0, 0];
    groundMat.emissiveColor = [0.2, 0.2, 0.2];
    ground.material = groundMat;
    ground.receiveShadows = true;
    addToScene(scene, ground);

    const box = createBox(engine, 5);
    box.position.set(0, 5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [1.0, 0, 0];
    boxMat.specularColor = [0.5, 0, 0];
    box.material = boxMat;
    addToScene(scene, box);

    // Light A — off to the left; the box's shadow falls to the right.
    const lightA = createSpotLight([-8, 20, 0], [0.3, -1, 0], 1.2, 24);
    lightA.shadowGenerator = createPcfSpotlightShadowGenerator(engine, lightA, { mapSize: 512, near: cam.nearPlane, far: cam.farPlane });
    setShadowTaskCasterMeshes(lightA.shadowGenerator, [box]);
    addToScene(scene, lightA);

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);

    // Render a few frames with light A so the swap exercises the live/stale path.
    await nextFrame();
    await nextFrame();

    // Swap to light B — mirrored to the right, so the shadow flips to the left.
    removeFromScene(scene, lightA);
    const lightB = createSpotLight([8, 20, 0], [-0.3, -1, 0], 1.2, 24);
    lightB.shadowGenerator = createPcfSpotlightShadowGenerator(engine, lightB, { mapSize: 512, near: cam.nearPlane, far: cam.farPlane });
    setShadowTaskCasterMeshes(lightB.shadowGenerator, [box]);
    addToScene(scene, lightB);

    unregisterScene(scene);
    await registerSceneWithShadowSupport(scene);

    // `removeFromScene` armed the rebuild and `registerSceneWithShadowSupport` ran it. Record whether it
    // fully applied (the hook disarms itself only then) and, if a group was left on its previous build,
    // apply it explicitly — the same call an app makes for an add-only topology change.
    const internals = scene as unknown as { _rebuildHook?: unknown };
    canvas.dataset.rebuild = internals._rebuildHook ? "pending" : "applied";
    if (internals._rebuildHook) {
        await rebuildSceneRenderables(scene);
        canvas.dataset.rebuild = internals._rebuildHook ? "still-pending" : "applied-explicitly";
    }

    await nextFrame();
    await nextFrame();

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
