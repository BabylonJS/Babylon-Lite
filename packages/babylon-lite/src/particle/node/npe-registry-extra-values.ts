import type { NpeBlockEvaluator } from "./npe-build.js";

/** Optional scalar/vector utility blocks used by converted Change graphs. */
export async function loadValueBlockEvaluator(className: string): Promise<NpeBlockEvaluator> {
    switch (className) {
        case "ParticleConditionBlock":
            return (await import("./blocks/particle-condition-block.js")).particleConditionBlock;
        case "ParticleFloatToIntBlock":
            return (await import("./blocks/particle-float-to-int-block.js")).particleFloatToIntBlock;
        case "ParticleVectorLengthBlock":
            return (await import("./blocks/particle-vector-length-block.js")).particleVectorLengthBlock;
        case "ParticleLocalVariableBlock":
            return (await import("./blocks/particle-local-variable-block.js")).particleLocalVariableBlock;
        default:
            return (await import("./npe-registry-phase4-values.js")).loadPhase4ValueBlockEvaluator(className);
    }
}
