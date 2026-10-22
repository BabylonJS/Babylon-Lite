// Scene 325: glTF export round trip of PNG, JPEG and KTX2 textures — matches Babylon.js playground #8NTR5X#8
// (visualization test "GLTF Serializer un/compressed texture roundtrip", `roundtrip = true`).
//
// 16 PBR planes (4 textures x 4 creation methods) are exported with exportSceneAsGlb, reloaded with loadGltf and
// shown unlit. Babylon.js sets `debugMode = 20` on every reloaded material (PBR debug view: albedo texture rgb, gamma
// output); the closest public Lite equivalent is setPbrUnlit, which outputs the base colour directly, bypassing lighting
// and tone mapping.
// The four creation methods differ only in how Babylon.js hands the bytes to its Texture (constructor URL, updateURL,
// updateURL with a data: URL and buffer, with a random data: URL); Lite has one URL loader per format, so methods 0
// and 1 are the same cached call and methods 2 and 3 load the fetched bytes through a Blob URL.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createPbrMaterial,
    createPlane,
    createSceneContext,
    disposeScene,
    exportSceneAsGlb,
    loadGltf,
    loadKtx2Texture2D,
    loadTexture2D,
    registerScene,
    setPbrUnlit,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera, EngineContext, PbrMaterialProps, Texture2D } from "babylon-lite";

const ROUNDTRIP = true;
const TEXTURE_SOURCES = [
    "https://playground.babylonjs.com/textures/down.png",
    "https://playground.babylonjs.com/textures/grass.jpg",
    "https://playground.babylonjs.com/textures/ktx2/sample_uastc.ktx2",
    "https://playground.babylonjs.com/textures/palm.png",
];
const MIME_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", ktx2: "image/ktx2" };

// `{ invertY: false, useSRGBBuffer: true }` in the snippet.
function loadTexture(engine: EngineContext, url: string, isKtx2: boolean): Promise<Texture2D> {
    return isKtx2 ? loadKtx2Texture2D(engine, url, true) : loadTexture2D(engine, url, { invertY: false, srgb: true });
}

function loadFromUrl(engine: EngineContext, url: string): Promise<Texture2D> {
    return loadTexture(engine, url, url.endsWith(".ktx2"));
}

async function loadFromBytes(engine: EngineContext, url: string): Promise<Texture2D> {
    const data = await (await fetch(url)).arrayBuffer();
    const blobUrl = URL.createObjectURL(new Blob([data], { type: MIME_TYPES[url.slice(url.lastIndexOf(".") + 1)] }));
    return loadTexture(engine, blobUrl, url.endsWith(".ktx2"));
}

const TEXTURE_CREATION_METHODS: Array<(engine: EngineContext, url: string) => Promise<Texture2D>> = [loadFromUrl, loadFromUrl, loadFromBytes, loadFromBytes];

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    let scene = createSceneContext(engine);

    await Promise.all(
        TEXTURE_SOURCES.flatMap((url, i) =>
            TEXTURE_CREATION_METHODS.map(async (method, j) => {
                const texture = await method(engine, url);
                const plane = createPlane(engine, { size: 1 });
                plane.name = "plane_original" + i + j;
                plane.position.set(j, i, 0);
                const material = createPbrMaterial({ baseColorTexture: texture, metallicFactor: 0, roughnessFactor: 1 });
                material.name = "material_original" + i + j;
                plane.material = material;
                addToScene(scene, plane);
            })
        )
    );

    if (ROUNDTRIP) {
        const blob = await exportSceneAsGlb(scene);
        disposeScene(scene);
        scene = createSceneContext(engine);
        addToScene(scene, await loadGltf(engine, blob));
    }

    // Babylon.js: scene.materials.forEach((m) => (m.debugMode = 20)).
    for (const mesh of scene.meshes) {
        setPbrUnlit(mesh.material as PbrMaterialProps);
    }

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, TEXTURE_SOURCES.length * 1.2, {
        x: TEXTURE_SOURCES.length / 2 - 0.5,
        y: TEXTURE_CREATION_METHODS.length / 2 - 0.5,
        z: 0,
    });
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;
    attachControl(camera as ArcRotateCamera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
