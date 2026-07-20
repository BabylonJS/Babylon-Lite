import type { ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";

/**
 * @internal A single gradient stop, produced by a `ParticleGradientValueBlock` and consumed by its parent
 * `ParticleGradientBlock`. It flows along the graph as the block's output value (mirroring the BJS
 * `*Gradient` connection types). `value` is evaluated lazily, per particle/frame.
 */
export interface ParticleGradientEntry {
    readonly reference: number;
    readonly value: NpeGetter;
}

/**
 * `ParticleGradientValueBlock` — one stop of a gradient: a `reference` key (0..1) and a `value` input. Its
 * output carries the stop itself (a {@link ParticleGradientEntry}); the parent `ParticleGradientBlock`
 * reads the reference and evaluates the value. Mirrors BJS `ParticleGradientValueBlock`.
 */
export const particleGradientValueBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const reference = typeof block.serialized.reference === "number" ? block.serialized.reference : 0;
        const value = ctx.input(block, "value", () => 0);
        const entry: ParticleGradientEntry = { reference, value };
        // The entry is an internal wire value understood only by ParticleGradientBlock.
        ctx.setOutput(block.id, "output", () => entry as unknown as ParticleValue);
    },
};
