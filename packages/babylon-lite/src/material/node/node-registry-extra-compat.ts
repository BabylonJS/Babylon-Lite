import type { BlockEmitter } from "./node-types.js";
import type { BlockLoader } from "./node-registry.js";

function blockLoader(key: string): BlockLoader | null {
    switch (key) {
        case "ElbowBlock":
            return () => import("./blocks/elbow-block.js");
        case "NodeMaterialTeleportInBlock":
            return () => import("./blocks/teleport-in-block.js");
        case "NodeMaterialTeleportOutBlock":
            return () => import("./blocks/teleport-out-block.js");
        case "NodeMaterialDebugBlock":
            return () => import("./blocks/debug-block.js");
        case "MeshAttributeExistsBlock":
            return () => import("./blocks/mesh-attribute-exists-block.js");
        case "ClipPlanesBlock":
            return () => import("./blocks/clip-planes-block.js");
        case "ReflectionTextureBaseBlock":
            return () => import("./blocks/reflection-texture-base-block.js");
        case "ImageProcessingBlock":
            return () => import("./blocks/image-processing-block.js");
        case "IridescenceBlock":
            return () => import("./blocks/iridescence-block.js");
        case "LoopBlock":
            return () => import("./blocks/loop-block.js");
        case "StorageReadBlock":
            return () => import("./blocks/storage-read-block.js");
        case "StorageWriteBlock":
            return () => import("./blocks/storage-write-block.js");
        default:
            return null;
    }
}

export async function loadExtraEmitter(key: string): Promise<BlockEmitter> {
    const loader = blockLoader(key);
    if (!loader) {
        throw new Error(`NodeMaterial: no compatibility extension emitter registered for block "${key}"`);
    }
    return (await loader()).emitter;
}
