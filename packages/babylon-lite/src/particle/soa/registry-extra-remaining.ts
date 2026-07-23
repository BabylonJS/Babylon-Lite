import type { SoaBlockEvaluator } from "./npe-build.js";

/** Route uncommon optional families only after the ordinary optional registry misses. */
export async function loadRemainingBlockEvaluator(className: string): Promise<SoaBlockEvaluator> {
    return className.startsWith("Particle")
        ? (await import("./registry-extra-values.js")).loadValueBlockEvaluator(className)
        : (await import("./registry-extra-basic.js")).loadBasicBlockEvaluator(className);
}
