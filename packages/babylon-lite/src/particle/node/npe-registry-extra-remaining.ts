import type { NpeBlockEvaluator } from "./npe-build.js";

/** Route uncommon optional families only after the ordinary optional registry misses. */
export async function loadRemainingBlockEvaluator(className: string): Promise<NpeBlockEvaluator> {
    return className.startsWith("Particle")
        ? (await import("./npe-registry-extra-values.js")).loadValueBlockEvaluator(className)
        : (await import("./npe-registry-extra-basic.js")).loadBasicBlockEvaluator(className);
}
