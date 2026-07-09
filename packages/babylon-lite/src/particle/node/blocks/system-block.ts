import type { Texture2D } from "../../../texture/texture-2d.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `SystemBlock` — the graph root. Applies system-level configuration (capacity, update speed, blend and
 * billboard modes, emit rate, target stop duration, texture) onto the {@link ParticleSystem} built by the
 * upstream `particle` chain. Mirrors the configuration done in BJS `SystemBlock.createSystem`.
 */
export const systemBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem | null;
        if (!system) {
            return;
        }

        system.name = block.name;

        const serialized = block.serialized;
        if (typeof serialized.updateSpeed === "number") {
            system.updateSpeed = serialized.updateSpeed;
        }
        if (typeof serialized.blendMode === "number") {
            system.blendMode = serialized.blendMode;
        }
        if (typeof serialized.billBoardMode === "number") {
            system.billboardMode = serialized.billBoardMode;
        }
        if (typeof serialized.isBillboardBased === "boolean") {
            system.isBillboardBased = serialized.isBillboardBased;
        }
        if (typeof serialized.isLocal === "boolean") {
            system.isLocal = serialized.isLocal;
        }
        if (typeof serialized.capacity === "number") {
            system.capacity = serialized.capacity;
        }

        // A dynamic emit rate (e.g. an emit-rate gradient over the system's target duration) is connected to
        // a source and must be re-evaluated every step from the current `_actualFrame`; store a getter the
        // animate loop calls. A constant emit rate is read once here and frozen.
        if (ctx.isConnected(block, "emitRate")) {
            const emitRateGetter = ctx.input(block, "emitRate", () => 10);
            system._emitRateGetter = (sys) => {
                state.system = sys;
                const rate = emitRateGetter(state);
                return typeof rate === "number" ? rate : sys.emitRate;
            };
        } else {
            // Clear any previously-installed getter so a constant rate is never shadowed by a stale
            // dynamic getter (defensive if this block ever re-runs against an already-configured system).
            system._emitRateGetter = null;
            const emitRate = ctx.input(block, "emitRate", () => 10)(state);
            if (typeof emitRate === "number") {
                system.emitRate = emitRate;
            }
        }

        const targetStop = ctx.input(block, "targetStopDuration", () => 0)(state);
        if (typeof targetStop === "number") {
            system.targetStopDuration = targetStop;
        }

        // The texture loads asynchronously; bind it once the build's asset promises settle.
        const textureGetter = ctx.input(block, "texture");
        system._resolveTexture = () => {
            system.texture = (textureGetter(state) as Texture2D | null) ?? null;
        };
    },
};
