import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createEsmDirectionalShadowGenerator,
    createGround,
    createPbrMaterial,
    createSceneContext,
    createSphere,
    disposeEngine,
    disposeScene,
    enableDeviceLostSceneRecovery,
    type EnvironmentTextures,
    forceWebGpuDeviceLossForTesting,
    loadEnvironment,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
    stopEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const oldDevice = engine._device;
    const recordGpuError = (event: Event): void => {
        const message = (event as GPUUncapturedErrorEvent).error.message;
        canvas.dataset.gpuError = message;
        console.error(message);
    };
    oldDevice.addEventListener("uncapturederror", recordGpuError);

    let oldEnvironment: GPUTexture;
    let environmentIdentity: EnvironmentTextures | undefined;
    let oldFallback: GPUTexture;
    let oldShadow: GPUTexture;
    const recovery = enableDeviceLostSceneRecovery(engine, {
        onLost() {
            canvas.dataset.deviceLost = "true";
        },
        onRecovered() {
            engine._device.addEventListener("uncapturederror", recordGpuError);
            canvas.dataset.deviceRecovered = "true";
            canvas.dataset.deviceReplaced = String(engine._device !== oldDevice);
            canvas.dataset.environmentIdentityPreserved = String(scene._envTextures === environmentIdentity);
            canvas.dataset.environmentRebuilt = String(scene._envTextures?.specularCube !== oldEnvironment);
            canvas.dataset.fallbackRebuilt = String(engine._pbrFallbackTex?.texture !== oldFallback);
            canvas.dataset.shadowRebuilt = String(light.shadowGenerator?._depthTexture !== oldShadow);
        },
        onRecoveryFailed(error) {
            const message = error instanceof Error ? error.message : String(error);
            canvas.dataset.recoveryFailed = message;
            canvas.dataset.error = message;
            console.error(error);
        },
    });

    const scene = createSceneContext(engine);
    scene.fixedDeltaMs = 16;
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        brdfUrl: "/brdf-lut.png",
        skipSkybox: true,
        skipGround: true,
    });

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 7, { x: 0, y: 0.8, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const light = createDirectionalLight([-0.5, -1, -0.4], 2);
    light.position.set(4, 8, 4);
    addToScene(scene, light);

    const caster = createSphere(engine, { diameter: 2, segments: 24 });
    caster.position.set(0, 1.2, 0);
    caster.material = createPbrMaterial({
        metallicFactor: 0.15,
        roughnessFactor: 0.3,
        usePhysicalLightFalloff: false,
    });
    addToScene(scene, caster);

    const ground = createGround(engine, { width: 10, height: 10 });
    ground.receiveShadows = true;
    ground.material = createPbrMaterial({
        shadowOnly: true,
        shadowOnlyColor: [0, 0, 0],
        shadowOnlyOpacity: 0.45,
        shadowOnlyFalloff: 1,
    });
    addToScene(scene, ground);

    light.shadowGenerator = createEsmDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        blurKernel: 48,
        orthoMinZ: 0,
        orthoMaxZ: 1000,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, [caster]);

    let recoveredFrames = 0;
    onBeforeRender(scene, () => {
        if (canvas.dataset.deviceRecovered === "true") {
            recoveredFrames++;
            canvas.dataset.postRecoveryFrames = String(recoveredFrames);
            if (recoveredFrames >= 50) {
                canvas.dataset.ready = "true";
            }
        }
    });

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    environmentIdentity = scene._envTextures;
    oldEnvironment = scene._envTextures!.specularCube;
    oldFallback = engine._pbrFallbackTex!.texture;
    oldShadow = light.shadowGenerator._depthTexture;

    // Viewer-shaped teardown: disable recovery first, then stop rendering, then tear down
    // scene and engine. Exercised by the parity spec after post-recovery frames are drawn.
    (globalThis as { __scene164Dispose?: () => void }).__scene164Dispose = () => {
        recovery.disable();
        stopEngine(engine);
        disposeScene(scene);
        disposeEngine(engine);
        canvas.dataset.disposed = "true";
    };

    canvas.dataset.loaded = "true";
    forceWebGpuDeviceLossForTesting(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
