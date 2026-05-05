import type { BlockEmitter } from "./node-types.js";
import type { BlockLoader } from "./node-registry.js";

function blockLoader(key: string): BlockLoader | null {
    switch (key) {
        case "ColorMergerBlock":
            return () => import("./blocks/color-merger.js");
        case "ColorConverterBlock":
            return () => import("./blocks/color-converter-block.js");
        case "DesaturateBlock":
            return () => import("./blocks/desaturate-block.js");
        case "GradientBlock":
            return () => import("./blocks/gradient-block.js");
        case "PosterizeBlock":
            return () => import("./blocks/posterize-block.js");
        case "ReplaceColorBlock":
            return () => import("./blocks/replace-color-block.js");
        case "PannerBlock":
            return () => import("./blocks/panner-block.js");
        case "Rotate2dBlock":
            return () => import("./blocks/rotate2d-block.js");
        case "TriPlanarBlock":
            return () => import("./blocks/triplanar-block.js");
        case "BiPlanarBlock":
            return () => import("./blocks/biplanar-block.js");
        case "CloudBlock":
            return () => import("./blocks/cloud-block.js");
        case "SimplexPerlin3DBlock":
            return () => import("./blocks/simplex-perlin-3d-block.js");
        case "VoronoiNoiseBlock":
            return () => import("./blocks/voronoi-noise-block.js");
        case "WorleyNoise3DBlock":
            return () => import("./blocks/worley-noise-3d-block.js");
        default:
            return null;
    }
}

export async function loadExtraEmitter(key: string): Promise<BlockEmitter> {
    const loader = blockLoader(key);
    if (!loader) {
        throw new Error(`NodeMaterial: no procedural extension emitter registered for block "${key}"`);
    }
    return (await loader()).emitter;
}
