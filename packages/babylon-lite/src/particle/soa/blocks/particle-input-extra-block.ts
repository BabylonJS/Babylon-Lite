import { makeExtraContextualGetter } from "../contextual-extra.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/** `ParticleInputBlock` evaluator for contextual sources outside the common particle-scene subset. */
export const particleInputExtraBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const source = typeof block.serialized.contextualValue === "number" ? block.serialized.contextualValue : 0;
        ctx.setOutput(block.id, "output", makeExtraContextualGetter(ctx.state.buffer!, ctx.state.system!, source));
    },
};
