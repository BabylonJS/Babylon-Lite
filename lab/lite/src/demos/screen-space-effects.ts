/**
 * Demo — Screen-Space Effects.
 *
 * Shows Babylon Lite's ambient-occlusion, contact-shadow, and one-bounce
 * global-illumination tasks over the Cornell Box from zuuhr/GlobalIlumination-BabylonJS.
 * All three effects consume the same single-sample scene depth and can be toggled independently.
 * Asset source: https://github.com/zuuhr/GlobalIlumination-BabylonJS/blob/main/public/scenes/cornellBox.glb
 */
import {
    addTask,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPointLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createScreenSpaceAmbientOcclusionPostProcessTask,
    createScreenSpaceContactShadowsPostProcessTask,
    createScreenSpaceGlobalIlluminationPostProcessTask,
    getContainerMeshes,
    loadGltf,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import { demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

function bindToggle(buttonId: string, label: string, initial: boolean, update: (enabled: boolean) => void): void {
    const button = document.getElementById(buttonId) as HTMLButtonElement;
    let enabled = initial;
    const refresh = (): void => {
        button.textContent = `${label}: ${enabled ? "On" : "Off"}`;
        button.classList.toggle("disabled", !enabled);
        update(enabled);
    };
    button.addEventListener("click", () => {
        enabled = !enabled;
        refresh();
    });
    refresh();
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 187_416 });
    const engine = await createEngine(canvas, { maxDevicePixelRatio: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.025, g: 0.025, b: 0.025, a: 1 };

    const asset = await loadGltf(engine, demoAssetUrl("./screen-space-effects/cornellBox.glb", import.meta.url));
    const background = getContainerMeshes(asset).find((mesh) => mesh.name === "BackgroundPlane");
    if (background) {
        background.visible = false;
    }
    addToScene(scene, asset);

    const camera = createArcRotateCamera(Math.PI / 2, 1.35, 5.3, { x: 0, y: 1.2, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 50;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.08));
    addToScene(scene, createPointLight([0, 2.9, 0], 1.6));
    const sun = createDirectionalLight([0.3, -1, 0.18], 0.9);
    addToScene(scene, sun);

    const sceneTarget = createRenderTarget({
        lbl: "screen-space-effects-scene",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const sceneTask = createRenderTask(
        {
            name: "screen-space-effects-scene",
            rt: sceneTarget,
            clr: true,
            clrColor: scene.clearColor,
        },
        engine,
        scene
    );
    const contactShadows = createScreenSpaceContactShadowsPostProcessTask(
        {
            name: "screen-space-effects-contact",
            sourceTexture: sceneTarget,
            camera,
            lightDirection: sun.direction,
            stepCount: 12,
            maxDistance: 0.32,
            thickness: 0.35,
            bias: 0.03,
            normalBias: 0.035,
            intensity: 0.65,
            tint: [0.08, 0.1, 0.16],
            temporalWeight: 1 / 64,
            temporalSamples: 64,
            spatialRadius: 0.75,
        },
        engine,
        scene
    );
    const globalIllumination = createScreenSpaceGlobalIlluminationPostProcessTask(
        {
            name: "screen-space-effects-gi",
            sourceTexture: contactShadows.outputTexture,
            depthTexture: sceneTarget,
            camera,
            composition: "color-bleed",
            resolutionScale: 0.75,
            intensity: 1.9,
            stepCount: 8,
            rayCount: 4,
            rayLength: 2.2,
            thickness: 0.45,
            bias: 0.05,
            fadeStart: 0,
            fadeEnd: 20,
            temporalWeight: 1 / 64,
            temporalSamples: 64,
            colorBleedGain: 1.2,
            colorBleedMax: 0.5,
        },
        engine,
        scene
    );
    const ambientOcclusion = createScreenSpaceAmbientOcclusionPostProcessTask(
        {
            name: "screen-space-effects-ao",
            sourceTexture: globalIllumination.outputTexture,
            depthTexture: sceneTarget,
            camera,
            targetTexture: engine.scRT,
            resolutionScale: 0.5,
            intensity: 0.8,
            radius: 0.55,
            bias: 0.05,
            power: 1.5,
            sliceCount: 3,
            stepCount: 4,
            fadeStart: 15,
            fadeEnd: 35,
            temporalWeight: 1 / 32,
            temporalSamples: 64,
        },
        engine,
        scene
    );
    addTask(scene, sceneTask);
    addTask(scene, contactShadows);
    addTask(scene, globalIllumination);
    addTask(scene, ambientOcclusion);

    let autoOrbit = false;
    onBeforeRender(scene, (deltaMs) => {
        if (autoOrbit) {
            camera.alpha += deltaMs * 0.00008;
        }
    });

    bindToggle("toggleContact", "Contact shadows", true, (enabled) => {
        contactShadows.enabled = enabled;
    });
    bindToggle("toggleAo", "Ambient occlusion", true, (enabled) => {
        ambientOcclusion.enabled = enabled;
    });
    bindToggle("toggleGi", "Global illumination", true, (enabled) => {
        globalIllumination.enabled = enabled;
    });
    bindToggle("toggleOrbit", "Auto orbit", false, (enabled) => {
        autoOrbit = enabled;
    });

    await registerScene(scene);
    await startEngine(engine);
    progress.done();
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
