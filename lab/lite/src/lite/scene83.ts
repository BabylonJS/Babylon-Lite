// Scene 83: NME normals, derivatives, tangent basis, normal blend, and AO.

import { addToScene, attachControl, createArcRotateCamera, createDirectionalLight, createEngine, createPlane, createSceneContext, createSolidTexture2D, loadTexture2D, parseNodeMaterialFromSnippet, registerScene, startEngine } from "babylon-lite";
import { SCENE83_NME_JSON, SCENE83_POSITION_TEXTURE_URL } from "../shared/scene83-nme.js";

async function loadScene83BlockEmitter(className: string): Promise<any> {
    switch (className) {
        case "AddBlock":
            return (await import("babylon-lite/material/node/blocks/add-block.js")).emitter;
        case "AmbientOcclusionBlock":
            return (await import("babylon-lite/material/node/blocks/ambient-occlusion-block.js")).emitter;
        case "ColorMergerBlock":
            return (await import("babylon-lite/material/node/blocks/color-merger.js")).emitter;
        case "DerivativeBlock":
            return (await import("babylon-lite/material/node/blocks/derivative-block.js")).emitter;
        case "FragmentOutputBlock":
            return (await import("babylon-lite/material/node/blocks/fragment-output.js")).emitter;
        case "HeightToNormalBlock":
            return (await import("babylon-lite/material/node/blocks/height-to-normal-block.js")).emitter;
        case "ImageSourceBlock":
            return (await import("babylon-lite/material/node/blocks/image-source.js")).emitter;
        case "InputBlock":
            return (await import("babylon-lite/material/node/blocks/input-block.js")).emitter;
        case "LightBlock":
            return (await import("babylon-lite/material/node/blocks/light-block.js")).emitter;
        case "MultiplyBlock":
            return (await import("babylon-lite/material/node/blocks/multiply-block.js")).emitter;
        case "NormalBlendBlock":
            return (await import("babylon-lite/material/node/blocks/normal-blend-block.js")).emitter;
        case "PerturbNormalBlock":
            return (await import("babylon-lite/material/node/blocks/perturb-normal.js")).emitter;
        case "ScaleBlock":
            return (await import("babylon-lite/material/node/blocks/scale-block.js")).emitter;
        case "TBNBlock":
            return (await import("babylon-lite/material/node/blocks/tbn-block.js")).emitter;
        case "TextureBlock":
            return (await import("babylon-lite/material/node/blocks/texture-block.js")).emitter;
        case "TransformBlock":
            return (await import("babylon-lite/material/node/blocks/transform-block.js")).emitter;
        case "TrigonometryBlock":
            return (await import("babylon-lite/material/node/blocks/trigonometry-block.js")).emitter;
        case "VectorMergerBlock":
            return (await import("babylon-lite/material/node/blocks/vector-merger.js")).emitter;
        case "VectorSplitterBlock":
            return (await import("babylon-lite/material/node/blocks/vector-splitter.js")).emitter;
        case "VertexOutputBlock":
            return (await import("babylon-lite/material/node/blocks/vertex-output.js")).emitter;
        default:
            throw new Error(`Scene83: unsupported NME block "${className}"`);
    }
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const key = createDirectionalLight([0, 0, 1], 3.25);
    addToScene(scene, key);

    const aoDepth = createSolidTexture2D(engine, 0.5, 0.5, 0.5, 1);
    const positionTex = await loadTexture2D(engine, SCENE83_POSITION_TEXTURE_URL, { invertY: false });
    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE83_NME_JSON, textures: { AoDepth: aoDepth, PositionSample: positionTex }, blockLoader: loadScene83BlockEmitter });
    const plane = createPlane(engine, { width: 3.2, height: 2.2 });
    plane.material = material;
    addToScene(scene, plane);

    await registerScene(scene);
    await startEngine(engine);
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
