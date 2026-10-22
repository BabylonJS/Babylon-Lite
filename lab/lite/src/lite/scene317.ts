// Scene 317: glTF export, Shared Buffer Conversions. Babylon.js visualization test "GLTF Serializer Shared Buffer
// Conversions" (playground #KX53VK#85, `meshCount = 2`). Two meshes share one vertex-colored geometry (the same typed
// arrays), are exported with exportSceneAsGlb and reloaded with loadGltf.
import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, SceneContext } from "babylon-lite";

const meshCount = 2;

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
const indices = new Uint32Array([0, 1, 2]);
// Babylon.js ComputeNormals on this triangle gives (0, 0, -1) for every vertex.
const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]);

function createTriangle(engine: EngineContext, scene: SceneContext, name: string, x: number, y: number, z: number): void {
    // Every mesh is built from the same typed arrays, so the exporter sees one shared geometry.
    const mesh = createMeshFromData(engine, name, positions, normals, indices, undefined, undefined, undefined, colors);
    mesh.position.set(x, y, z);
    mesh.material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    mesh.material.name = "material_" + name;
    addToScene(scene, mesh);
}

async function exportThenImport(engine: EngineContext, scene: SceneContext): Promise<void> {
    const blob = await exportSceneAsGlb(scene);
    for (const mesh of scene.meshes.slice() as Mesh[]) {
        removeFromScene(scene, mesh);
    }
    addToScene(scene, await loadGltf(engine, blob));
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 3, { x: 0, y: 0, z: 0 });

    for (let i = 0; i < meshCount; i++) {
        createTriangle(engine, scene, String(i), -1 + (i % 2), -Math.floor(i / 2), 0);
    }

    await exportThenImport(engine, scene);

    // The snippet exports with shouldExportNode excluding lights; Lite's exporter has no filter, so the light joins the scene after the round trip.
    addToScene(scene, createDirectionalLight([0, 0, 1]));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
