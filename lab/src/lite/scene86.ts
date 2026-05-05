// Scene 86: NME scene/mesh state compatibility.

import { addToScene, attachControl, createArcRotateCamera, createEngine, createSceneContext, parseNodeMaterialFromSnippet, registerScene, startEngine } from "babylon-lite";
import type { EngineContextInternal } from "../../../packages/babylon-lite/src/engine/engine.js";
import { computeAabb } from "../../../packages/babylon-lite/src/math/aabb.js";
import type { Mesh, MeshInternal } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { initMeshTransform, uploadMeshToGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { Scene86MeshData } from "../shared/scene86-nme.js";
import { createScene86MeshData, SCENE86_CLIP_PLANE, SCENE86_NME_JSON } from "../shared/scene86-nme.js";

function createScene86Mesh(engine: EngineContextInternal, data: Scene86MeshData): Mesh {
    const [min, max] = computeAabb(data.positions);
    const mesh = {
        name: data.name,
        material: null as unknown as Mesh["material"],
        receiveShadows: false,
        boundMin: isFinite(min[0]) ? min : undefined,
        boundMax: isFinite(max[0]) ? max : undefined,
        _materialDirty: false,
        _gpu: uploadMeshToGPU(engine, data.positions, data.normals, data.indices, data.uvs, undefined, data.tangents, data.colors),
    } as MeshInternal;
    initMeshTransform(mesh);
    mesh._cpuPositions = data.positions;
    mesh._cpuNormals = data.normals;
    mesh._cpuUvs = data.uvs;
    mesh._cpuIndices = data.indices;
    return mesh;
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.02, b: 0.035, a: 1 };
    scene.clipPlane = SCENE86_CLIP_PLANE;

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE86_NME_JSON });
    for (const data of createScene86MeshData()) {
        const mesh = createScene86Mesh(engine as EngineContextInternal, data);
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
