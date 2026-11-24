import type { NpeBlockEvaluator } from "../npe-build.js";
import { createComponentScratch, mapComponents } from "./particle-component-map.js";

/**
 * `ParticleStepBlock` — per component, 0 below `edge` (default 0) and 1 otherwise. Like Babylon.js, an
 * unconnected `value` publishes no output and the output keeps the `value` typing.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "value")) {
            return;
        }
        const value = ctx.input(block, "value");
        const edge = ctx.input(block, "edge", () => 0);
        const scratch = createComponentScratch();
        let threshold = 0;
        const step = (component: number): number => (component < threshold ? 0 : 1);
        const readEdge = (i: number): void => {
            threshold = edge(i) as number;
        };

        ctx.setOutput(block.id, "output", (i) => mapComponents(value(i), step, scratch, readEdge, i), ctx.isInt(block, "value"));
    },
};
