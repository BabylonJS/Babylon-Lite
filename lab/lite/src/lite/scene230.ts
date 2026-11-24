// Scene 230: Bent Normals — bent-normal specular reflection occlusion.
// Mirrors Babylon.js PG #ZH5HB3#3: the same glTF loaded twice side by side; only
// the right copy gets a tangent-space bent normal texture, so the difference in
// IBL specular occlusion is directly visible. The PG's constant-roughness override
// is omitted (both engines keep the glTF ORM roughness).

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    enableBentNormals,
    loadEnvironment,
    loadGltf,
    loadTexture2D,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { AssetContainer, Mesh, PbrMaterialProps, SceneNode } from "babylon-lite";

const ROOT = "https://assets.babylonjs.com/meshes/BentNormalTest/";
const MODEL_URL = ROOT + "bent_normal_test.gltf";
const BENT_URL = ROOT + "bent_normal_low_bent_normal_mat_BentNormal_OpenGL.png";

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

    const [left, right, bent] = await Promise.all([loadGltf(engine, MODEL_URL), loadGltf(engine, MODEL_URL), loadTexture2D(engine, BENT_URL, { invertY: false })]);
    (left.entities[0] as SceneNode).position.x = -0.007;
    (right.entities[0] as SceneNode).position.x = 0.007;
    for (const mesh of collectMeshes(right)) {
        (mesh.material as PbrMaterialProps).bentNormalTexture = bent;
    }
    addToScene(scene, left);
    addToScene(scene, right);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });
    scene.clearColor = { r: 0.12, g: 0.12, b: 0.12, a: 1 };

    const camera = createArcRotateCamera(-1.35, 0.85, 0.037, { x: 0, y: 0.00172, z: 0 });
    camera.nearPlane = 0.00001;
    camera.farPlane = 1;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    enableBentNormals();
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
