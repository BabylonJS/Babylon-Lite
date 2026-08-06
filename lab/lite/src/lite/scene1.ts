import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    loadEnvironment,
    loadGltf,
    createHemisphericLight,
    attachControl,
    registerScene,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.querySelector("canvas")!;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha = 1.77538;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight());

    await registerScene(scene);
    await startEngine(engine);
    Object.assign(canvas.dataset, {
        drawCalls: engine.drawCallCount,
        initMs: performance.now() - __initStart,
        ready: true,
    });
}

main().catch(console.error);
