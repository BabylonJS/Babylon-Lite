import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";

/** Options for {@link enableCsmStaticCache}. */
export interface CsmStaticCacheOptions {
    /** Accumulated sun-rotation angle (radians) since the last cascade refit that forces the next one. */
    refitAngle: number;
    /** Force a refit after this much wall time, including while the light is paused. Default 0 (no interval floor). */
    refitMaxIntervalMs?: number;
}

let enabling: WeakMap<ShadowGenerator, Promise<void>> | null = null;

/**
 * Enables the opt-in static/dynamic caster cache for a CSM generator.
 *
 * Call and await this before registering the scene or requesting the generator's
 * receiver texture. The cache implementation is dynamically imported, so CSM scenes
 * that do not call this function fetch none of its code.
 */
export function enableCsmStaticCache(engine: EngineContext, sg: ShadowGenerator, options: CsmStaticCacheOptions): Promise<void> {
    if (sg._shadowType !== "csm") {
        return Promise.reject(new Error("enableCsmStaticCache requires a CSM shadow generator"));
    }
    if (!Number.isFinite(options.refitAngle) || options.refitAngle <= 0) {
        return Promise.reject(new RangeError("enableCsmStaticCache requires a positive finite refitAngle"));
    }
    if (sg._shadowTaskState || sg._csmReceiverTexture || engine.surfaces.some((surface) => surface._renderingContexts.length > 0)) {
        return Promise.reject(new Error("enableCsmStaticCache must run before scene registration and receiver texture access"));
    }
    if (sg._csmCache?._loaded) {
        return Promise.resolve();
    }
    const active = enabling?.get(sg);
    if (active) {
        return active;
    }
    const oldTexture = sg._depthTexture;
    const mapSize = sg._config._mapSize;
    sg._depthTexture = engine._device.createTexture({
        size: { width: mapSize, height: mapSize, depthOrArrayLayers: sg._csmCascadeCount! },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    sg._csmCache = { _refitAngle: options.refitAngle, _refitMaxIntervalMs: options.refitMaxIntervalMs ?? 0 };
    oldTexture.destroy();
    const promise = import("./csm-shadow-cache.js").then((module) => {
        sg._csmCache!._loaded = true;
        const config = sg._config as import("./csm-shadow-task-hooks.js").CsmConfig;
        const ensure: NonNullable<ShadowGenerator["_ensureShadowTaskState"]> = (eng, scene, casterMeshes) => {
            const state = module.ensureCsmShadowCacheState(eng, scene, sg, config, casterMeshes, sg._shadowTaskState ?? null);
            sg._shadowTaskState = state;
            return state;
        };
        const render: NonNullable<ShadowGenerator["_renderShadowMap"]> = (eng, state) =>
            module.renderCsmShadowMapCached(eng, sg, state as import("./csm-shadow-task-hooks.js").CsmTaskState, config);
        if (sg._replaceShadowTaskHooks) {
            sg._replaceShadowTaskHooks(ensure, render);
        } else {
            sg._ensureShadowTaskState = ensure;
            sg._renderShadowMap = render;
        }
    });
    (enabling ??= new WeakMap()).set(sg, promise);
    void promise.then(
        () => enabling?.delete(sg),
        () => enabling?.delete(sg)
    );
    return promise;
}
