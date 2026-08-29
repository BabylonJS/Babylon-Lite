import type { NpeBlockEvaluator, NpeBuildContext } from "../npe-build.js";
import { particleMathBlock } from "./particle-math-block.js";
import { particleMathCompactBlock } from "./particle-math-compact-block.js";

/** Add Babylon's left-Int coercion to a ParticleMath evaluator. */
function withIntMath(evaluator: NpeBlockEvaluator): NpeBlockEvaluator {
    return {
        build(block, ctx) {
            const intContext: NpeBuildContext = {
                ...ctx,
                setOutput(blockId, name, getter) {
                    ctx.setOutput(blockId, name, (index) => (getter(index) as number) | 0);
                },
            };
            evaluator.build(block, intContext);
        },
    };
}

/** Left-Int ParticleMath evaluator for distinct input sources. */
export const particleIntMathBlock = withIntMath(particleMathCompactBlock);

/** Left-Int ParticleMath evaluator that snapshots aliased input sources. */
export const particleIntMathAliasBlock = withIntMath(particleMathBlock);
