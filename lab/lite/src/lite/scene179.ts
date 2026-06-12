// Scene 179 — Clustered Sponza Lights
// Babylon playground #CSCJO2#89: Khronos Sponza glTF with 1000 small point
// lights rendered through Lite's clustered PBR direct-light path.

import {
    addToScene,
    attachFreeControl,
    createEngine,
    createFreeCamera,
    createSceneContext,
    loadGltf,
    registerScene,
    startEngine,
    type PbrMaterialProps,
} from "babylon-lite";
import { addClusteredLightContainer, createClusteredLightContainer, createClusteredPointLight } from "babylon-lite/light/clustered";

const MODEL_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Sponza/glTF/Sponza.gltf";

function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (1664525 * s + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createFreeCamera({ x: -5, y: 2, z: 0 }, { x: 0, y: 3, z: 0 });
    camera.speed = 0.2;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    const asset = await loadGltf(engine, MODEL_URL);
    addToScene(scene, asset);
    for (const mesh of scene.meshes) {
        const mat = mesh.material as PbrMaterialProps | undefined;
        if (mat) {
            mat.usePhysicalLightFalloff = true;
        }
    }

    const clustered = createClusteredLightContainer({ horizontalTiles: 64, verticalTiles: 64, zSlices: 16 });
    const rnd = seededRandom(0x5eed177);
    for (let i = 0; i < 1000; i++) {
        createClusteredPointLight(clustered, {
            position: [rnd() * 20 - 10, rnd() * 10, rnd() * 10 - 5],
            diffuse: [rnd(), rnd(), rnd()],
            range: 1,
        });
    }
    addClusteredLightContainer(scene, clustered);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
    canvas.dataset.initMs = String(performance.now() - __initStart);
}

main().catch(console.error);
