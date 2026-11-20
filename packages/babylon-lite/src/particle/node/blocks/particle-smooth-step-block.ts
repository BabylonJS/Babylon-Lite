import type { NpeBlockEvaluator } from "../npe-build.js";
import { copyComponent, createComponentScratch, mapComponents } from "./particle-component-map.js";

/**
 * `ParticleSmoothStepBlock` — per-component Hermite `3x² - 2x³` of `value` between `edge0` (default 0) and
 * `edge1` (default 1). Like Babylon.js, an unconnected `value` publishes no output and the output keeps the
 * `value` typing.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "value")) {
            return;
        }
        const value = ctx.input(block, "value");
        const edge0 = ctx.input(block, "edge0", () => 0);
        const edge1 = ctx.input(block, "edge1", () => 1);
        const scratch = createComponentScratch();
        let start = 0;
        let end = 1;
        const smoothStep = (component: number): number => {
            const x = Math.max(0, Math.min((component - start) / (end - start), 1));
            return x * x * (3 - 2 * x);
        };

        ctx.setOutput(
            block.id,
            "output",
            (i) => {
                const source = mapComponents(value(i), copyComponent, scratch);
                start = edge0(i) as number;
                end = edge1(i) as number;
                return mapComponents(source, smoothStep, scratch);
            },
            ctx.isInt(block, "value")
        );
    },
};
