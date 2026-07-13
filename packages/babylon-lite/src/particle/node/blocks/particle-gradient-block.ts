import { lerpValue } from "./particle-lerp.js";
import type { ParticleGradientEntry } from "./particle-gradient-value-block.js";
import type { ParticleBlockEvaluator, NpeGetter } from "../npe-types.js";

/**
 * `ParticleGradientBlock` — interpolates between gradient stops (each a `ParticleGradientValueBlock` wired
 * to a `valueN` input) by the scalar `gradient` input (typically the age/lifetime ratio). Stops are sorted
 * by reference once at build; on evaluation the value is lerped between the stop at or below `gradient` and
 * the next one above it (component-wise for vectors/colours). A `gradient` below the lowest stop yields 0.
 * Mirrors BJS `ParticleGradientBlock`.
 */
export const particleGradientBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const gradientGetter = ctx.input(block, "gradient", () => 1);

        // The stops are static blocks, so resolve them (reference + value getter) once and sort by reference.
        const entries = block.inputs
            .filter((input) => input.name.startsWith("value") && input.targetBlockId != null)
            .map((input) => ctx.input(block, input.name)(ctx.state) as unknown as ParticleGradientEntry)
            .sort((a, b) => a.reference - b.reference);

        const getter: NpeGetter = (state) => {
            const gradient = gradientGetter(state) as number;
            if (entries.length === 1) {
                return entries[0]!.value(state);
            }

            // Walk from the top: interpolate between the stop at/below `gradient` and the next one above it.
            let next: ParticleGradientEntry | null = null;
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i]!;
                if (entry.reference <= gradient) {
                    const currentValue = entry.value(state);
                    if (next) {
                        const scale = Math.max(0, Math.min(1, (gradient - entry.reference) / (next.reference - entry.reference)));
                        return lerpValue(currentValue, next.value(state), scale);
                    }
                    return currentValue;
                }
                next = entry;
            }
            return 0;
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
