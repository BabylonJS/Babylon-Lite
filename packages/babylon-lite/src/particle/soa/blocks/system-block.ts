import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `SystemBlock` (SoA) — the graph root. Applies update speed, blend mode, emit rate, and target stop
 * duration onto the {@link SoaSystem} built by the upstream `particle` chain. The texture is bound by the
 * texture-source block. Connected emit-rate graphs use the serialized variant evaluator, which installs
 * an optional per-step getter after applying this shared configuration.
 */
export const systemBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;

        const serialized = block.serialized;
        if (typeof serialized.updateSpeed === "number") {
            system.updateSpeed = serialized.updateSpeed;
        }
        if (typeof serialized.blendMode === "number") {
            system.blendMode = serialized.blendMode;
        }

        if (!ctx.isConnected(block, "emitRate")) {
            const emitRate = ctx.input(block, "emitRate", () => 10)(0);
            if (typeof emitRate === "number") {
                system.emitRate = emitRate;
            }
        }

        const targetStop = ctx.input(block, "targetStopDuration", () => 0)(0);
        if (typeof targetStop === "number") {
            system.targetStopDuration = targetStop;
        }
    },
};
