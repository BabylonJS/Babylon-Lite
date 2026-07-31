import { createRandomDraw } from "./particle-random-block.js";
import { createOnceRandomGetter } from "./particle-random-once.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter } from "../npe-value.js";

/** Scalar `ParticleRandomBlock` evaluator for OncePerParticle lock mode. */
export const particleRandomOnceBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const draw = createRandomDraw(
            ctx.input(block, "min", () => 0),
            ctx.input(block, "max", () => 1)
        );
        ctx.setOutput(block.id, "output", createOnceRandomGetter(ctx.state.buffer!, block.id, draw as ScalarGetter));
    },
};
