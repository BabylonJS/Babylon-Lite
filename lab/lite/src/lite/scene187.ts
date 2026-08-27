// Scene 187 — Subpixel Morphological Anti-Aliasing (SMAA)
//
// The same single-sample image is presented twice: raw on the left and through
// SMAA on the right. Thin shallow-angle bars, radial spokes, an alpha-cutout
// fence, and a tight specular highlight expose several kinds of image-space
// aliasing without introducing animation or screenshot timing variance.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    createArcRotateCamera,
    createBox,
    createCopyToTextureTask,
    createEngine,
    createPlane,
    createPointLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSmaaPostProcessTask,
    createSphere,
    createStandardMaterial,
    enableOrthographicCamera,
    loadTexture2D,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, StandardMaterialProps } from "babylon-lite";

const PANEL_WIDTH = 0.5;
const ORTHO_HALF_HEIGHT = 5.4;

function createUnlitMaterial(color: readonly [number, number, number]): StandardMaterialProps {
    const material = createStandardMaterial();
    material.diffuseColor = [color[0], color[1], color[2]];
    material.emissiveColor = [color[0], color[1], color[2]];
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    return material;
}

function createBar(engine: EngineContext, material: StandardMaterialProps, x: number, y: number, length: number, thickness: number, angle: number): Mesh {
    const bar = createBox(engine, 1);
    bar.position.set(x, y, 0);
    bar.scaling.set(length, thickness, 0.05);
    bar.rotation.z = angle;
    bar.material = material;
    return bar;
}

function createFenceTextureUrl(): string {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Scene 187 requires a 2D canvas context.");
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f5f8ff";
    for (let x = -220; x < 420; x += 32) {
        context.save();
        context.translate(x, 128);
        context.rotate(-0.28);
        context.fillRect(-4, -180, 8, 360);
        context.restore();
    }
    context.fillRect(0, 42, 256, 8);
    context.fillRect(0, 206, 256, 8);
    return canvas.toDataURL("image/png");
}

async function addStressGeometry(engine: EngineContext, scene: ReturnType<typeof createSceneContext>): Promise<void> {
    const background = createBox(engine, 1);
    background.position.z = 0.45;
    background.scaling.set(9.2, 10.6, 0.1);
    background.material = createUnlitMaterial([0.025, 0.035, 0.055]);
    addToScene(scene, background);

    const white = createUnlitMaterial([0.96, 0.98, 1]);
    const cyan = createUnlitMaterial([0.12, 0.82, 1]);
    const orange = createUnlitMaterial([1, 0.38, 0.08]);

    const shallowBars = [
        { y: 4.15, angle: 0.018, thickness: 0.035, material: white },
        { y: 3.55, angle: -0.032, thickness: 0.045, material: cyan },
        { y: 2.92, angle: 0.065, thickness: 0.055, material: orange },
        { y: 2.25, angle: -0.12, thickness: 0.07, material: white },
    ];
    for (const bar of shallowBars) {
        addToScene(scene, createBar(engine, bar.material, 0, bar.y, 7.7, bar.thickness, bar.angle));
    }

    const spokeCenterX = -2.05;
    const spokeCenterY = -1.3;
    const spokeLength = 2.65;
    for (let i = 0; i < 24; i++) {
        const angle = (i * Math.PI) / 12;
        const spoke = createBar(
            engine,
            i % 3 === 0 ? cyan : white,
            spokeCenterX + (Math.cos(angle) * spokeLength) / 2,
            spokeCenterY + (Math.sin(angle) * spokeLength) / 2,
            spokeLength,
            0.035,
            angle
        );
        addToScene(scene, spoke);
    }

    const hub = createSphere(engine, { diameter: 0.28, segments: 24 });
    hub.position.set(spokeCenterX, spokeCenterY, -0.08);
    hub.material = orange;
    addToScene(scene, hub);

    const fenceMaterial = createStandardMaterial();
    fenceMaterial.disableLighting = true;
    fenceMaterial.emissiveColor = [1, 1, 1];
    fenceMaterial.diffuseTexture = await loadTexture2D(engine, createFenceTextureUrl(), {
        mipMaps: false,
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });
    fenceMaterial.alphaCutOff = 0.5;
    fenceMaterial.backFaceCulling = false;

    const fence = createPlane(engine, { width: 3.35, height: 2.45 });
    fence.position.set(2.15, -2.2, -0.08);
    fence.material = fenceMaterial;
    addToScene(scene, fence);

    const glossy = createSphere(engine, { diameter: 2.05, segments: 48 });
    glossy.position.set(2.15, 0.9, -0.05);
    const glossyMaterial = createStandardMaterial();
    glossyMaterial.diffuseColor = [0.035, 0.045, 0.07];
    glossyMaterial.specularColor = [1, 1, 1];
    glossyMaterial.specularPower = 256;
    glossy.material = glossyMaterial;
    addToScene(scene, glossy);

    const light = createPointLight([2.9, 2.25, -3.2], 2.8);
    light.range = 12;
    addToScene(scene, light);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const debug = new URLSearchParams(window.location.search).get("debug") === "1";
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.008, g: 0.012, b: 0.02, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 30;
    enableOrthographicCamera(camera, { halfHeight: ORTHO_HALF_HEIGHT });
    scene.camera = camera;

    await addStressGeometry(engine, scene);

    const sourceTarget = createRenderTarget({
        lbl: "scene187-source",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: { width: Math.max(1, Math.floor(canvas.width * PANEL_WIDTH)), height: canvas.height },
    });
    const sourceTask = createRenderTask(
        {
            name: "scene187-source",
            rt: sourceTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );
    addTaskAtStart(scene, sourceTask);

    const smaa = createSmaaPostProcessTask(
        {
            name: "scene187-smaa",
            sourceTexture: sourceTarget,
            targetTexture: engine.scRT,
            viewport: { x: PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height: 1 },
            clear: true,
            threshold: 0.03,
            maxSearchSteps: 64,
        },
        engine,
        scene
    );
    addTask(scene, smaa);
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "scene187-no-aa",
                sourceTexture: sourceTarget,
                targetTexture: engine.scRT,
                viewport: { x: 0, y: 0, width: PANEL_WIDTH, height: 1 },
            },
            engine,
            scene
        )
    );

    await registerScene(scene);
    smaa.updateUniforms();
    await startEngine(engine);

    canvas.dataset.comparison = "no-aa-left,smaa-right";
    canvas.dataset.smaa = "true";
    canvas.dataset.smaaThreshold = String(smaa.threshold);
    canvas.dataset.smaaMaxSearchSteps = String(smaa.maxSearchSteps);
    canvas.dataset.smaaDiagonalDetection = String(smaa.diagonalDetection);
    canvas.dataset.smaaMinDiagonalRun = String(smaa.minDiagonalRun);
    canvas.dataset.smaaCornerDetection = String(smaa.cornerDetection);
    canvas.dataset.smaaDominantAxisBlend = String(smaa.dominantAxisBlend);
    canvas.dataset.smaaSourceIsSrgb = String(smaa.sourceIsSrgb);
    canvas.dataset.smaaDebug = String(debug);
    if (debug) {
        const { attachSmaaDebugControls } = await import("./scene187-debug.js");
        attachSmaaDebugControls(smaa, canvas);
    }
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
