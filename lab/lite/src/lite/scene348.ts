// Scene 348: screen-space ambient occlusion in the Diligent Kitchen (DiligentGraphics/USDAssets, Apache-2.0),
// hosted in BabylonJS/Assets. The scene is lit by the environment only: Lite
// applies XeGTAO with temporal filtering to PBR diffuse environment lighting, while the Babylon.js
// reference uses SSAO2RenderingPipeline, which multiplies the final color. The algorithms differ,
// so parity uses a wider MAD ceiling.
import {
    addTask,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCopyToTextureTask,
    createEngine,
    createGeometryRendererTask,
    createPbrMaterial,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSsaoTask,
    enablePbrSsao,
    enableSsaoHalfResolution,
    GeometryTextureType,
    getContainerMeshes,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    registerScene,
    resetSsaoTemporal,
    startEngine,
    stopEngine,
} from "babylon-lite";
import { KITCHEN_ASSET_URL } from "../shared/kitchen-asset.js";

// Temporal accumulation converges over the 64-frame noise cycle. Setup can still recreate the AO
// owners (and reset history) during the first frames, at a timing-dependent frame, so history is
// reset explicitly once settled and the presented frame is frozen a fixed number of frames later.
const RESET_FRAME = 16;
const FROZEN_FRAME = RESET_FRAME + 128;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    const camera = createArcRotateCamera(1.8, 1.4, 1.5, { x: 0, y: 1.3, z: 0 });
    camera.nearPlane = 0.05;
    camera.farPlane = 20;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    // Original vertex colors on a white, rough, non-metallic base.
    const kitchen = await loadGltf(engine, KITCHEN_ASSET_URL);
    const material = createPbrMaterial({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 });
    for (const mesh of getContainerMeshes(kitchen)) {
        mesh.material = material;
    }
    addToScene(scene, kitchen);
    await loadEnvironment(scene, "/textures/environment.env", { brdfUrl: "/brdf-lut.png", skipSkybox: true, skipGround: true });

    const geometry = createGeometryRendererTask({ name: "ssao-geometry", samples: 1, textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);
    const ao = createSsaoTask(
        { depthTexture: geometry.geometryDepthTexture, normalTexture: geometry.geometryViewNormalTexture!, camera, radius: 0.3, quality: "medium" },
        engine,
        scene
    );
    const temporal = ao.temporal;
    // Fast configuration: reduced geometry, estimation and temporal history, then full-size edge-aware output.
    enableSsaoHalfResolution(ao);
    await enablePbrSsao(scene, ao);
    const colorTarget = createRenderTarget({ lbl: "ssao-lit", format: engine.format, dFormat: "depth32float", samples: 1, size: engine });
    addTask(scene, geometry);
    addTask(scene, ao);
    addTask(scene, createRenderTask({ name: "ssao-lit", rt: colorTarget, clr: true }, engine, scene));
    addTask(scene, createCopyToTextureTask({ name: "ssao-present", sourceTexture: colorTarget, targetTexture: engine.scRT }, engine, scene));

    const interactive = new URLSearchParams(window.location.search).has("interactive");
    let frames = 0;
    onBeforeRender(scene, () => {
        if (++frames === RESET_FRAME) {
            resetSsaoTemporal(temporal);
        }
        if (frames === FROZEN_FRAME && !interactive) {
            // This frame still renders and stays presented; no further frame is scheduled.
            stopEngine(engine);
            requestAnimationFrame(() => {
                canvas.dataset.initMs = String(performance.now() - initStart);
                canvas.dataset.ready = "true";
            });
        }
    });
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    if (interactive) {
        canvas.dataset.ready = "true";
    }
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
