import type { NpeBlockEvaluator } from "../npe-build.js";
import { createComponentScratch, mapComponents } from "./particle-component-map.js";

/**
 * `ParticleClampBlock` — clamp every component of `value` to `[min, max]` (defaults 0 and 1). Like Babylon.js,
 * an unconnected `value` publishes no output and the output keeps the `value` typing.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "value")) {
            return;
        }
        const value = ctx.input(block, "value");
        const min = ctx.input(block, "min", () => 0);
        const max = ctx.input(block, "max", () => 1);
        const scratch = createComponentScratch();
        let lower = 0;
        let upper = 1;
        const clamp = (component: number): number => Math.max(lower, Math.min(component, upper));
        const readBounds = (i: number): void => {
            lower = min(i) as number;
            upper = max(i) as number;
        };

        ctx.setOutput(block.id, "output", (i) => mapComponents(value(i), clamp, scratch, readBounds, i), ctx.isInt(block, "value"));
    },
};
