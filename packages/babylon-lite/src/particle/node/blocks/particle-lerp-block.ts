import { lerpValue } from "./particle-lerp.js";
import type { ParticleBlockEvaluator, NpeGetter } from "../npe-types.js";

/**
 * `ParticleLerpBlock` — linearly interpolates between `left` and `right` by a scalar `gradient`,
 * component-wise for vectors/colours. Mirrors BJS `ParticleLerpBlock`.
 */
export const particleLerpBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const leftGetter = ctx.input(block, "left");
        const rightGetter = ctx.input(block, "right");
        const gradientGetter = ctx.input(block, "gradient", () => 0);

        const getter: NpeGetter = (state) => {
            const gradient = gradientGetter(state);
            return lerpValue(leftGetter(state), rightGetter(state), typeof gradient === "number" ? gradient : 0);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
