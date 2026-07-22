import type { SoaBlockEvaluator } from "../npe-build.js";
import type { SoaGetter, SoaValue } from "../value.js";

/** One static gradient stop; its value remains lazy and is evaluated per particle/frame. */
export interface SoaGradientEntry {
    readonly reference: number;
    readonly value: SoaGetter;
}

/** `ParticleGradientValueBlock` (SoA) — emits gradient-stop metadata for its parent gradient block. */
export const particleGradientValueBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const reference = typeof block.serialized.reference === "number" ? block.serialized.reference : 0;
        const entry: SoaGradientEntry = { reference, value: ctx.input(block, "value", () => 0) };
        ctx.setOutput(block.id, "output", () => entry as unknown as SoaValue);
    },
};
