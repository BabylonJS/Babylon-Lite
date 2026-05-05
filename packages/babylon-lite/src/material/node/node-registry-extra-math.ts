import type { BlockEmitter } from "./node-types.js";
import type { BlockLoader } from "./node-registry.js";

function blockLoader(key: string): BlockLoader | null {
    switch (key) {
        case "DivideBlock":
            return () => import("./blocks/divide-block.js");
        case "ModBlock":
            return () => import("./blocks/mod-block.js");
        case "ReciprocalBlock":
            return () => import("./blocks/reciprocal-block.js");
        case "LengthBlock":
            return () => import("./blocks/length-block.js");
        case "DistanceBlock":
            return () => import("./blocks/distance-block.js");
        case "CrossBlock":
            return () => import("./blocks/cross-block.js");
        case "ReflectBlock":
            return () => import("./blocks/reflect-block.js");
        case "RefractBlock":
            return () => import("./blocks/refract-block.js");
        case "ArcTan2Block":
            return () => import("./blocks/arc-tan2-block.js");
        case "FresnelBlock":
            return () => import("./blocks/fresnel-block.js");
        case "OppositeBlock":
            return () => import("./blocks/opposite-block.js");
        case "NLerpBlock":
            return () => import("./blocks/nlerp-block.js");
        case "ConditionalBlock":
            return () => import("./blocks/conditional-block.js");
        case "CurveBlock":
            return () => import("./blocks/curve-block.js");
        case "WaveBlock":
            return () => import("./blocks/wave-block.js");
        case "RandomNumberBlock":
            return () => import("./blocks/random-number-block.js");
        default:
            return null;
    }
}

export async function loadExtraEmitter(key: string): Promise<BlockEmitter> {
    const loader = blockLoader(key);
    if (!loader) {
        throw new Error(`NodeMaterial: no math extension emitter registered for block "${key}"`);
    }
    return (await loader()).emitter;
}
