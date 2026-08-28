import type { NpeBlockEvaluator } from "./npe-build.js";
import type { ParsedParticleBlock } from "./npe-types.js";

/** Phase 4 value math routing, loaded only after the established value registry misses. */
export async function loadPhase4ValueBlockEvaluator(block: ParsedParticleBlock): Promise<NpeBlockEvaluator | undefined> {
    switch (block.className) {
        case "ParticleNumberMathBlock":
            return (await import("./blocks/particle-number-math-block.js")).particleNumberMathBlock;
        case "ParticleIntMathBlock":
            return (await import("./blocks/particle-math-int-block.js")).particleIntMathBlock;
        case "ParticleIntMathAliasBlock":
            return (await import("./blocks/particle-math-int-block.js")).particleIntMathAliasBlock;
        case "ParticleClampBlock":
            return (await import("./blocks/particle-clamp-block.js")).particleClampBlock;
        case "ParticleStepBlock":
            return (await import("./blocks/particle-step-block.js")).particleStepBlock;
        default:
            return undefined;
    }
}
