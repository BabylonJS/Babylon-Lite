import type { NpeBlockEvaluator } from "../npe-build.js";
import { copyComponent, createComponentScratch, mapComponents } from "./particle-component-map.js";

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

        ctx.setOutput(
            block.id,
            "output",
            (i) => {
                const source = mapComponents(value(i), copyComponent, scratch);
                threshold = edge(i) as number;
                return mapComponents(source, step, scratch);
            },
            ctx.isInt(block, "value")
        );
    },
};
