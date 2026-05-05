import type { BlockEmitter } from "./node-types.js";
import type { BlockLoader } from "./node-registry.js";

function matrixBlocks(): ReturnType<BlockLoader> {
    return import("./blocks/matrix-blocks.js");
}

function blockLoader(key: string): BlockLoader | null {
    switch (key) {
        case "DerivativeBlock":
            return () => import("./blocks/derivative-block.js");
        case "HeightToNormalBlock":
            return () => import("./blocks/height-to-normal-block.js");
        case "TBNBlock":
            return () => import("./blocks/tbn-block.js");
        case "NormalBlendBlock":
            return () => import("./blocks/normal-blend-block.js");
        case "AmbientOcclusionBlock":
            return () => import("./blocks/ambient-occlusion-block.js");
        case "FragCoordBlock":
            return () => import("./blocks/frag-coord-block.js");
        case "ScreenSizeBlock":
            return () => import("./blocks/screen-size-block.js");
        case "ScreenSpaceBlock":
            return () => import("./blocks/screen-space-block.js");
        case "TwirlBlock":
            return () => import("./blocks/twirl-block.js");
        case "FragDepthBlock":
            return () => import("./blocks/frag-depth-block.js");
        case "MatrixBuilder":
        case "MatrixSplitterBlock":
        case "MatrixTransposeBlock":
        case "MatrixDeterminantBlock":
            return matrixBlocks;
        default:
            return null;
    }
}

export async function loadExtraEmitter(key: string): Promise<BlockEmitter> {
    const loader = blockLoader(key);
    if (!loader) {
        throw new Error(`NodeMaterial: no advanced extension emitter registered for block "${key}"`);
    }
    return (await loader()).emitter;
}
