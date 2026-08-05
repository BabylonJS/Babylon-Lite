// Scene 164 - Device Lost Recovery
//
// Exercises every family of GPU resource the recovery pipeline has to rebuild, in one scene:
// the Alien glTF contributes textures, a skeleton, morph targets and an animation group; an
// IBL environment plus a PBR fallback texture cover the scene-owned resources that are not
// reachable through `mesh.material`; an ESM directional shadow generator covers shadow
// textures, buffers, pipelines, bind groups and frame-graph task state. Two lights keep the
// multi-light WGSL permutation live, which is what surfaces `lightsUniforms` ordering bugs.
//
// Device loss is not a visual feature, so there is nothing to compare against stable Babylon
// here and no golden reference. The property worth asserting is invariance: the scene renders
// the same image after recovery as it did before the device was destroyed. To make that
// comparable, the animation is pinned to a fixed frame *before* the loss, and the scene waits
// for `dataset.captured` before destroying the device so the harness can screenshot the
// pre-loss frame without racing.
//
// `dataset.ready` is deliberately withheld until after recovery has settled: the bundle
// harness stops measuring at `ready`, so setting it before the loss would exclude every byte
// of the recovery path from this scene's recorded size.
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createEsmDirectionalShadowGenerator,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    disposeEngine,
    disposeScene,
    enableDeviceLostSceneRecovery,
    type EnvironmentTextures,
    forceWebGpuDeviceLossForTesting,
    getContainerMeshes,
    goToFrame,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    pauseAnimation,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
    stopEngine,
} from "babylon-lite";

const SETTLE_FRAMES = 12;
const POST_RECOVERY_FRAMES = 50;
/** How long to hold the device open when nothing signals `dataset.captured` (bundle harness). */
const CAPTURE_TIMEOUT_MS = 3000;

function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve) => {
        const start = performance.now();
        const poll = (): void => {
            if (predicate() || performance.now() - start >= timeoutMs) {
                resolve();
                return;
            }
            requestAnimationFrame(poll);
        };
        poll();
    });
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(window.location.search);
    const freezeFrame = (parseFloat(params.get("seekTime") || "2") || 2) * 60;

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

    const freezeAnimation = (): void => {
        for (const group of scene.animationGroups) {
            goToFrame(group, freezeFrame);
            pauseAnimation(group);
        }
        canvas.dataset.animationFrozen = "true";
    };

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
            // Animation state is rebuilt with the rest of the scene, so re-pin the clip to the
            // same frame the reference render uses.
            freezeAnimation();
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

    const camera = createArcRotateCamera(Math.PI / 2, 1.15, 1.6, { x: 0.1, y: -0.05, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    const light = createDirectionalLight([-0.5, -1, -0.4], 2);
    light.position.set(4, 8, 4);
    addToScene(scene, light);

    const alien = await loadGltf(engine, "https://playground.babylonjs.com/scenes/Alien/Alien.gltf");
    addToScene(scene, alien);

    const ground = createGround(engine, { width: 8, height: 8 });
    ground.position.set(0, -0.75, 0);
    ground.receiveShadows = true;
    // Dark, high-contrast shadow on purpose: the pre/post comparison can only catch a shadow
    // recovery regression to the extent the shadow actually moves pixels.
    ground.material = createPbrMaterial({
        shadowOnly: true,
        shadowOnlyColor: [0, 0, 0],
        shadowOnlyOpacity: 0.95,
        shadowOnlyFalloff: 1,
    });
    addToScene(scene, ground);

    light.shadowGenerator = createEsmDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        blurKernel: 16,
        orthoMinZ: 0,
        orthoMaxZ: 1000,
        // The caster is skinned and morphed, so the shadow map has to track the current pose.
        // It also makes the 50 post-recovery frames re-run the rebuilt shadow pass every frame
        // rather than sampling a map rendered once during recovery.
        forceRefreshEveryFrame: true,
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, getContainerMeshes(alien));

    let frames = 0;
    let recoveredFrames = 0;
    onBeforeRender(scene, () => {
        frames++;
        canvas.dataset.frameCount = String(frames);
        if (canvas.dataset.deviceRecovered === "true") {
            recoveredFrames++;
            canvas.dataset.postRecoveryFrames = String(recoveredFrames);
            if (recoveredFrames >= POST_RECOVERY_FRAMES) {
                canvas.dataset.ready = "true";
            }
            return;
        }
        if (frames === SETTLE_FRAMES) {
            freezeAnimation();
        }
        // Let the frozen pose propagate through the shadow map before the reference capture,
        // so the pre-loss image is fully settled rather than mid-transition.
        if (frames === SETTLE_FRAMES + 4) {
            canvas.dataset.preLossReady = "true";
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
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);

    // Hold the live device open until the pre-loss frame has been captured, so the comparison
    // is against a settled, animation-pinned image rather than whatever happened to be on
    // screen. The parity spec sets `dataset.captured` the moment it has that screenshot; the
    // bundle harness never does, so fall back to a timeout instead of stalling forever.
    await waitFor(() => canvas.dataset.preLossReady === "true");
    await waitFor(() => canvas.dataset.captured === "true", CAPTURE_TIMEOUT_MS);
    forceWebGpuDeviceLossForTesting(engine);
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
