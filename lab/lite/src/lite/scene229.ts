// Scene 229: Triangle Without Indices — non-indexed glTF primitive regression.

import { addToScene, attachControl, createArcRotateCamera, createEngine, createSceneContext, loadGltf, registerScene, setPbrUnlit, startEngine } from "babylon-lite";
import type { ArcRotateCamera, AssetContainer, Mesh, PbrMaterialProps } from "babylon-lite";

const MODEL_URL = "https://cx20.github.io/gltf-test/tutorialModels/TriangleWithoutIndices/glTF/TriangleWithoutIndices.gltf";

function collectMeshes(container: AssetContainer): Mesh[] {
    const out: Mesh[] = [];
    const stack: unknown[] = [...container.entities];
    while (stack.length > 0) {
        const node = stack.pop() as { _gpu?: unknown; material?: unknown; children?: unknown[] } | undefined;
        if (!node) {
            continue;
        }
        if ("_gpu" in node && "material" in node) {
            out.push(node as unknown as Mesh);
        }
        if (node.children?.length) {
            stack.push(...node.children);
        }
    }
    return out;
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const asset = await loadGltf(engine, MODEL_URL);
    for (const mesh of collectMeshes(asset)) {
        const material = mesh.material as PbrMaterialProps;
        setPbrUnlit(material, [0.5, 0.5, 0.5]);
    }
    addToScene(scene, asset);

    const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 2.2, { x: 0.5, y: 0.5, z: 0 });
    camera.fov = 0.7;
    scene.camera = camera;
    attachControl(camera as ArcRotateCamera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
