import type { NpeBlockEvaluator, NpeBuildContext } from "../npe-build.js";
import { particleMathBlock } from "./particle-math-block.js";
import { particleMathCompactBlock } from "./particle-math-compact-block.js";

/** Add scalar Int coercion to a ParticleMath evaluator selected for an all-Int result. */
function withIntMath(evaluator: NpeBlockEvaluator): NpeBlockEvaluator {
    return {
        build(block, ctx) {
            const intContext: NpeBuildContext = {
                ...ctx,
                setOutput(blockId, name, getter) {
                    ctx.setOutput(blockId, name, (index) => {
                        const value = getter(index);
                        return typeof value === "number" ? value | 0 : value;
                    });
                },
            };
            evaluator.build(block, intContext);
        },
    };
}

/** All-Int ParticleMath evaluator for distinct input sources. */
export const particleIntMathBlock = withIntMath(particleMathCompactBlock);

/** All-Int ParticleMath evaluator that snapshots aliased input sources. */
export const particleIntMathAliasBlock = withIntMath(particleMathBlock);
