import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `SystemBlock` — the graph root. Applies update speed, blend mode, emit rate, target stop duration, and the
 * particle texture onto the {@link ParticleSystem} built by the upstream `particle` chain. A connected emit-rate
 * graph installs a per-step getter. A connected texture source loads as a build promise, so the set is only
 * ready once it settles.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;

        const serialized = block.serialized;
        if (typeof serialized.updateSpeed === "number") {
            system.updateSpeed = serialized.updateSpeed;
        }
        if (typeof serialized.blendMode === "number") {
            system.blendMode = serialized.blendMode;
        }

        if (ctx.isConnected(block, "emitRate")) {
            const emitRateGetter = ctx.input(block, "emitRate");
            system._emitRateGetter = () => {
                const emitRate = emitRateGetter(0);
                return typeof emitRate === "number" ? emitRate : system.emitRate;
            };
        } else {
            const emitRate = ctx.input(block, "emitRate", () => 10)(0);
            if (typeof emitRate === "number") {
                system.emitRate = emitRate;
            }
        }

        const targetStop = ctx.input(block, "targetStopDuration", () => 0)(0);
        if (typeof targetStop === "number") {
            system.targetStopDuration = targetStop;
        }

        const texture = ctx.texture(block, "texture");
        if (texture?.url) {
            ctx.addBuildPromise(
                (async () => {
                    // A failed loader-module import rejects the build. Any rejection from loadTexture2D itself, including its
                    // own lazy mipmap import, is tolerated below with image failures.
                    const { loadTexture2D } = await import("../../../texture/texture-2d.js");
                    try {
                        // Lite's billboard V runs opposite to Babylon.js, so a block invertY of false maps to an upload flip.
                        system.texture = await loadTexture2D(ctx.engine, texture.url, { invertY: !texture.invertY });
                    } catch {
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
