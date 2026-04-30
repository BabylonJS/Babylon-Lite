import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    loadEnvironment,
    loadGltf,
    loadTexture2D,
    parseNodeMaterialFromSnippet,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { AssetContainer, Mesh, Texture2D } from "babylon-lite";
import { getScene73Nme } from "../shared/scene73-nme.js";

const MODEL_URL = "/models/CarbonFiberWheel.glb";
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function collectMeshes(container: AssetContainer): Mesh[] {
    const meshes: Mesh[] = [];
    const visit = (node: unknown): void => {
        if (node && typeof node === "object") {
            if ("_gpu" in node && "material" in node) {
                meshes.push(node as Mesh);
            }
            const children = (node as { children?: readonly unknown[] }).children;
            if (children) {
                for (const child of children) {
                    visit(child);
                }
            }
        }
    };
    for (const entity of container.entities) {
        visit(entity);
    }
    return meshes;
}

async function loadSnippetTextures(engine: Parameters<typeof loadTexture2D>[0], json: unknown): Promise<Record<string, Texture2D>> {
    const blocks = (json as { blocks?: Array<Record<string, unknown>> }).blocks ?? [];
    const out: Record<string, Texture2D> = {};
    for (const b of blocks) {
        if (b.customType !== "BABYLON.TextureBlock" && b.customType !== "BABYLON.ImageSourceBlock") {
            continue;
        }
        const tex = b.texture as { url?: string; name?: string; invertY?: boolean } | undefined;
        const url = tex?.url && tex.url.length > 0 ? tex.url : tex?.name;
        if (!url) {
            continue;
        }
        out[sanitize((b.name as string | undefined) || `tex${b.id}`)] = await loadTexture2D(engine, url, { invertY: tex?.invertY ?? true });
    }
    return out;
}

async function loadScene73BlockEmitter(className: string): Promise<any> {
    switch (className) {
        case "ClearCoatBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/clearcoat-block.js")).emitter;
        case "ColorSplitterBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/color-splitter.js")).emitter;
        case "FragmentOutputBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/fragment-output.js")).emitter;
        case "InputBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/input-block.js")).emitter;
        case "PBRMetallicRoughnessBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/pbr-metallic-roughness-block.js")).emitter;
        case "PerturbNormalBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/perturb-normal.js")).emitter;
        case "ReflectionBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/reflection-block.js")).emitter;
        case "TextureBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/texture-block.js")).emitter;
        case "TransformBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/transform-block.js")).emitter;
        case "VertexOutputBlock":
            return (await import("../../../packages/babylon-lite/src/material/node/blocks/vertex-output.js")).emitter;
        default:
            throw new Error(`Scene73: unsupported NME block "${className}"`);
    }
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const left = createSceneContext(engine);
    const right = createSceneContext(engine);
    left.clearColor = { r: 0, g: 0, b: 0, a: 1 };
    right.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    left.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1, { x: 0, y: 0, z: 0 });
    left.camera.nearPlane = 0.1;
    left.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };

    right.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1, { x: 0, y: 0, z: 0 });
    right.camera.nearPlane = 0.1;
    right.camera.viewport = { x: 0.5, y: 0, width: 0.5, height: 1 };

    await Promise.all([
        loadEnvironment(left, ENV_URL, { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" }),
        loadEnvironment(right, ENV_URL, { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" }),
    ]);

    const leftWheel = await loadGltf(engine, MODEL_URL);
    const rightWheel = await loadGltf(engine, MODEL_URL);
    const nmeJson = await getScene73Nme();
    const textures = await loadSnippetTextures(engine, nmeJson);
    const nme = await parseNodeMaterialFromSnippet(engine, "", { json: nmeJson, textures, blockLoader: loadScene73BlockEmitter });
    for (const mesh of collectMeshes(rightWheel)) {
        mesh.material = nme;
    }

    addToScene(left, leftWheel);
    addToScene(right, rightWheel);

    await registerScene(engine, left);
    await registerScene(engine, right);
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
