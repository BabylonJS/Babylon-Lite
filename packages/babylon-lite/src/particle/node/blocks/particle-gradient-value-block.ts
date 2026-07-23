import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter, NpeValue } from "../npe-value.js";

/** One static gradient stop; its value remains lazy and is evaluated per particle/frame. */
export interface NpeGradientEntry {
    readonly reference: number;
    readonly value: NpeGetter;
}

/** `ParticleGradientValueBlock` — emits gradient-stop metadata for its parent gradient block. */
export const particleGradientValueBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const reference = typeof block.serialized.reference === "number" ? block.serialized.reference : 0;
        const entry: NpeGradientEntry = { reference, value: ctx.input(block, "value", () => 0) };
        ctx.setOutput(block.id, "output", () => entry as unknown as NpeValue);
    },
};
