import type { NpeBlockEvaluator } from "./npe-build.js";

/** Phase 4 value math routing, loaded only after the established value registry misses. */
export async function loadPhase4ValueBlockEvaluator(className: string): Promise<NpeBlockEvaluator> {
    switch (className) {
        case "ParticleNumberMathBlock":
            return (await import("./blocks/particle-number-math-block.js")).particleNumberMathBlock;
        case "ParticleClampBlock":
            return (await import("./blocks/particle-clamp-block.js")).particleClampBlock;
        case "ParticleStepBlock":
            return (await import("./blocks/particle-step-block.js")).particleStepBlock;
        default:
            throw new Error(`NodeParticle: unsupported value block "${className}"`);
    }
}
