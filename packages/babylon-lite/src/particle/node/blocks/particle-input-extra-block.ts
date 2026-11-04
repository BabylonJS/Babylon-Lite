import { makeExtraContextualGetter } from "../npe-contextual-extra.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** `ParticleInputBlock` evaluator for contextual sources outside the common particle-scene subset. */
export const particleInputExtraBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const source = typeof block.serialized.contextualValue === "number" ? block.serialized.contextualValue : 0;
        ctx.setOutput(block.id, "output", makeExtraContextualGetter(ctx.state.buffer!, ctx.state.system!, source));
    },
};
