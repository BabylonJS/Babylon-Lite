// Scene 210 — Khronos XmpMetadataRoundedCube (KHR_xmp_json_ld)
// Exercises the KHR_xmp_json_ld glTF extension: JSON-LD metadata packets are
// surfaced on the AssetContainer (asset.xmpMetadata) with zero render impact.
// The cube interleaves POSITION+NORMAL in one bufferView (byteStride 24), which
// the engine renders genuinely interleaved: the raw bufferView slice is uploaded
// once and bound to both attribute slots at their offsets (no asset rewrite).

import { addToScene, attachControl, createArcRotateCamera, createEngine, createHemisphericLight, createSceneContext, loadGltf, registerScene, startEngine } from "babylon-lite";

const MODEL_URL = "/models/XmpMetadataRoundedCube.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const asset = await loadGltf(engine, MODEL_URL);
    addToScene(scene, asset);
    // Surface the parsed XMP metadata (provenance/licensing) — render-inert.
    canvas.dataset.xmpPackets = String(asset.xmpMetadata?.packets?.length ?? 0);

    const cam = createArcRotateCamera(-Math.PI / 4, Math.PI / 3, 48, { x: 0, y: 9.95, z: 0 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
