import type { NpeBlockEvaluator } from "../npe-build.js";
import { systemBlock } from "./system-block.js";

/** `SystemBlock` evaluator for a connected emit-rate graph. */
export const systemDynamicEmitRateBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        systemBlock.build(block, ctx);
        const system = ctx.state.system!;
        const emitRateGetter = ctx.input(block, "emitRate", () => system.emitRate);
        system._emitRateGetter = () => {
            const emitRate = emitRateGetter(0);
            return typeof emitRate === "number" ? emitRate : system.emitRate;
        };
    },
};
