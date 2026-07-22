import { createRandomDraw } from "./particle-random-block.js";
import { createTypedOnceRandomGetter } from "./particle-random-once-typed.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/** Vector/color `ParticleRandomBlock` evaluator for OncePerParticle lock mode. */
export const particleRandomOnceTypedBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const valueType = block.inputs.find((input) => input.name === "min")?.valueType ?? block.inputs.find((input) => input.name === "max")?.valueType ?? "BABYLON.Vector3";
        const draw = createRandomDraw(
            ctx.input(block, "min", () => 0),
            ctx.input(block, "max", () => 1)
        );
        ctx.setOutput(block.id, "output", createTypedOnceRandomGetter(ctx.state.buffer!, block.id, draw, valueType));
    },
};
