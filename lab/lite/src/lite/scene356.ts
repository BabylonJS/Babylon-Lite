// Scene 356 — selective glow over Standard, PBR and NodeMaterial surfaces (GlowPostProcessTask).
// The NodeMaterial with a connected glow input renders its striped, vertex-stretched glow through its own shader;
// the bright plain NodeMaterial and the door only occlude. Every API used by the Babylon.js reference runs through
// the compat layer, so PBR emissive textures and unlit PBR live in scene 357.

import {
    addTask,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGlowPostProcessTask,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    parseNodeMaterialFromSnippet,
    registerScene,
    setPbrEmissive,
    setStandardEmissiveTexture,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Material, SceneContext } from "babylon-lite";
import { GLOW_SCENE, settle } from "../shared/scene356-glow.js";
import { SCENE356_GLOW_NME_JSON, SCENE356_PLAIN_NME_JSON } from "../shared/scene356-nme.js";

function box(engine: EngineContext, scene: SceneContext, material: Material, position: readonly [number, number, number], size: readonly [number, number, number]): void {
    const mesh = createBox(engine, { width: size[0], height: size[1], depth: size[2] });
    mesh.material = material;
    mesh.position.set(...position);
    addToScene(scene, mesh);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const [r, g, b] = GLOW_SCENE.background;
    scene.clearColor = { r, g, b, a: 1 };
    const [tx, ty, tz] = GLOW_SCENE.target;
    const camera = createArcRotateCamera(GLOW_SCENE.alpha, GLOW_SCENE.beta, GLOW_SCENE.radius, { x: tx, y: ty, z: tz });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([...GLOW_SCENE.lightDirection], GLOW_SCENE.lightIntensity));

    const matte = createStandardMaterial();
    matte.diffuseColor = [...GLOW_SCENE.matteDiffuse];
    matte.specularColor = [...GLOW_SCENE.matteSpecular];
    box(engine, scene, matte, [0, 1.5, 0.9], [8, 3.2, 0.2]);
    box(engine, scene, matte, [0, 0, 0], [8, 0.15, 3]);

    const cyan = createStandardMaterial();
    cyan.disableLighting = true;
    cyan.emissiveColor = [0.03, 0.8, 1];
    box(engine, scene, cyan, [-3, 1.5, 0.4], [0.1, 2.5, 0.1]);
    box(engine, scene, matte, [-3, 0.9, -0.1], [1, 1.4, 0.2]);

    const magenta = createPbrMaterial({ baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1 });
    setPbrEmissive(magenta, [1, 0.04, 0.32]);
    box(engine, scene, magenta, [-1.7, 1.5, 0.4], [0.1, 2.5, 0.1]);

    const amber = createStandardMaterial();
    amber.disableLighting = true;
    amber.emissiveColor = [1, 1, 1];
    setStandardEmissiveTexture(amber, createTexture2DFromPixels(engine, new Uint8Array([255, 89, 6, 255]), 1, 1));
    box(engine, scene, amber, [-0.3, 2.65, 0.4], [1.6, 0.1, 0.1]);

    const nodeGlow = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE356_GLOW_NME_JSON });
    box(engine, scene, nodeGlow, [1.3, 1.25, 0.4], [1.2, 1.2, 0.1]);
    const nodePlain = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE356_PLAIN_NME_JSON });
    box(engine, scene, nodePlain, [1.75, 0.8, -0.35], [0.7, 0.7, 0.7]);

    const output = scene.defaultRenderTask!.config;
    addTask(
        scene,
        createGlowPostProcessTask(
            { name: "glow", targetTexture: output.rt, resolveTexture: output.rst, intensity: GLOW_SCENE.intensity, blurKernelSize: GLOW_SCENE.kernel },
            engine,
            scene
        )
    );

    await registerScene(scene);
    await startEngine(engine);
    await settle(GLOW_SCENE.settleFrames);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
