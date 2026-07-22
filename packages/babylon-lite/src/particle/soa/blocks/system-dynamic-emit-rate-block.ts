import type { SoaBlockEvaluator } from "../npe-build.js";

/** Explicit rejection until dynamic emit-rate evaluation is implemented as an optional runtime feature. */
export const systemDynamicEmitRateBlock: SoaBlockEvaluator = {
    build() {
        throw new Error("SoA NodeParticle: dynamic emitRate is not implemented yet");
    },
};
