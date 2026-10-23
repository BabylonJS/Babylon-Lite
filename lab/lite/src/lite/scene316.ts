// Scene 316: glTF export, Negative World Matrix. Babylon.js visualization test "GLTF Serializer with Negative World
// Matrix (left handed, twice)", playground #KX53VK#88.
// Four vertex-colored triangles (CCW / CW winding, two under a negatively scaled + rotated parent) are exported with
// exportSceneAsGlb and reloaded with loadGltf `iterations` times (default 1). The parity test uses `?iterations=2`.
import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createTransformNode,
    enableDeviceLostSceneRecovery,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, SceneContext, TransformNode } from "babylon-lite";

const iterations = Number(new URLSearchParams(location.search).get("iterations") ?? "1");

const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
// Both Babylon.js triangles end up with the vertex normal (0, 0, -1) (ComputeNormals with the handedness switch the snippet passes).
const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]);
const POSITIONS = {
    CCW: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    CW: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]),
};
// Lite has no per-material sideOrientation. Its triangles are front-facing when wound against their vertex normals
// (the "CCW" array here); the "CW" array is wound with its normals (glTF style), so its index order is reversed to keep
// the same vertices and the same visible face.
const INDICES = {
    CCW: new Uint32Array([0, 1, 2]),
    CW: new Uint32Array([0, 2, 1]),
};

function createTriangle(engine: EngineContext, scene: SceneContext, name: string, x: number, y: number, z: number, winding: "CCW" | "CW", addInvertedParent: boolean): void {
    const mesh = createMeshFromData(engine, name, POSITIONS[winding], normals, INDICES[winding], undefined, undefined, undefined, colors);
    mesh.position.set(x, y, z);
    mesh.material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    mesh.material.name = "material_" + name;
    if (addInvertedParent) {
        // parent.scaling.z = -1; parent.rotation.y = Math.PI (quaternion (0, 1, 0, 0), scale (1, 1, -1)).
        const parent: TransformNode = createTransformNode("InvertNode", 0, 0, 0, 0, 1, 0, 0, 1, 1, -1);
        mesh.parent = parent;
        parent.children.push(mesh);
        addToScene(scene, parent);
    } else {
        addToScene(scene, mesh);
    }
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
    // Loaded meshes keep no CPU copy of their vertex colors unless this opt-in is active at load time; without it the second
    // export would drop them (Babylon.js keeps all vertex data). Closest public Lite equivalent for the 'twice' test.
    enableDeviceLostSceneRecovery(engine);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0.5, z: 0 });

    createTriangle(engine, scene, "CCW", -1, 1, 0, "CCW", false);
    createTriangle(engine, scene, "CW", 1, 1, 0, "CW", false);
    createTriangle(engine, scene, "CCW_Inverted", -1, -1, 0, "CCW", true);
    createTriangle(engine, scene, "CW_Inverted", 1, -1, 0, "CW", true);

    for (let i = 0; i < iterations; i++) {
        await exportThenImport(engine, scene);
    }

    // The snippet exports with shouldExportNode excluding lights; Lite's exporter has no filter, so the light joins the scene after the round trips.
    addToScene(scene, createDirectionalLight([0, 0, 1]));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
