// Scene 86: NME scene/mesh state compatibility.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createMeshFromData,
    createSceneContext,
    parseNodeMaterialFromSnippet,
    registerScene,
    setClipPlane,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh } from "babylon-lite";
import type { Scene86MeshData } from "../shared/scene86-nme.js";
import { createScene86MeshData, SCENE86_CLIP_PLANE, SCENE86_NME_JSON } from "../shared/scene86-nme.js";

function createScene86Mesh(engine: EngineContext, data: Scene86MeshData): Mesh {
    return createMeshFromData(engine, data.name, data.positions, data.normals, data.indices, data.uvs, undefined, data.tangents, data.colors);
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.02, b: 0.035, a: 1 };
    setClipPlane(scene, SCENE86_CLIP_PLANE);

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE86_NME_JSON });
    for (const data of createScene86MeshData()) {
        const mesh = createScene86Mesh(engine, data);
        mesh.position.x = data.x;
        mesh.material = material;
        addToScene(scene, mesh);
    }

    await registerScene(engine, scene);
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
