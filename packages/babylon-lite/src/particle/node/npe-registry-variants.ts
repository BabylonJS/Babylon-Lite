import type { NpeBlockEvaluator } from "./npe-build.js";
import type { ParsedParticleBlock } from "./npe-types.js";

/** Resolve serialized variants that should add zero loader bytes to ordinary block instances. */
export async function loadVariantBlockEvaluator(block: ParsedParticleBlock): Promise<NpeBlockEvaluator> {
    switch (block.className) {
        case "ParticleInputBlock": {
            if (block.serialized.contextualValue === 0x18) {
                return (await import("./blocks/particle-input-local-block.js")).particleInputLocalBlock;
            }
            return (await import("./blocks/particle-input-extra-block.js")).particleInputExtraBlock;
        }
        case "ParticleMathBlock":
            return (await import("./blocks/particle-math-block.js")).particleMathBlock;
        case "ParticleRandomBlock": {
            const valueType = block.inputs.find((input) => input.name === "min")?.valueType ?? block.inputs.find((input) => input.name === "max")?.valueType ?? "number";
            if (valueType[0] === "B") {
                return (await import("./blocks/particle-random-once-typed-block.js")).particleRandomOnceTypedBlock;
            }
            return (await import("./blocks/particle-random-once-block.js")).particleRandomOnceBlock;
        }
        case "SystemBlock":
            return (await import("./blocks/system-dynamic-emit-rate-block.js")).systemDynamicEmitRateBlock;
        case "SetupSpriteSheetBlock":
            return (await import("./blocks/setup-sprite-sheet-random-block.js")).setupSpriteSheetRandomBlock;
        default:
            throw new Error(`NodeParticle: unsupported block variant "${block.className}"`);
    }
}
