import type { NpeBlockEvaluator } from "./npe-build.js";

/** Optional block table for the Basic Properties extension slice. */
export async function loadBasicBlockEvaluator(className: string): Promise<NpeBlockEvaluator> {
    switch (className) {
        case "UpdateDirectionBlock":
            return (await import("./blocks/update-direction-block.js")).updateDirectionBlock;
        case "UpdateAngleBlock":
            return (await import("./blocks/update-angle-block.js")).updateAngleBlock;
        default:
            throw new Error(`NodeParticle: unsupported Basic Properties block "${className}"`);
    }
}
