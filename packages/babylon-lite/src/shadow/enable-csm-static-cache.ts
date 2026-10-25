import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import type { CsmConfig, CsmTaskState } from "./csm-shadow-task-hooks.js";

/** Options for {@link enableCsmStaticCache}. */
export interface CsmStaticCacheOptions {
    /** Accumulated sun-rotation angle (radians) since the last cascade refit that forces the next one. */
    refitAngle: number;
    /** Force a refit after this much wall time, including while the light is paused. Default 0 (no interval floor). */
    refitMaxIntervalMs?: number;
    /** Spread a drift-only refit's static re-render over frames: at most this many cascades are
     *  re-rendered per frame, round-robin, so the periodic refresh costs a slice of every frame instead
     *  of one long frame. Refits caused by the camera, the content or the caster membership still
     *  re-render every cascade in their own frame. 0 or omitted keeps the single-frame re-render. */
    staticCascadesPerFrame?: number;
    /** Opt-in camera-coverage refit, for stabilized cascades only. Each cascade's bounding sphere is widened by this
     *  fraction (0.2 = 20 % wider, so 1/1.2 of the texel density), and a camera move no longer refits every cascade:
     *  a cascade is refit and re-rendered, alone and in that same frame, only when the camera's current slice leaves
     *  the area its published map covers (outside the unit disc of its shadow clip space, or outside its light-depth
     *  range). A change of field of view, near/far plane or aspect still refits every cascade. 0 or omitted keeps
     *  the historical behaviour: every camera change refits and re-renders all cascades. A positive value must be at
     *  least 2 / mapSize: texel snapping shifts a fit by up to sqrt(2) / mapSize of its radius, and a smaller padding
     *  would leave a FRESH fit failing its own coverage test (refit every frame). */
    cascadeCoveragePadding?: number;
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
    const staticCascadesPerFrame = options.staticCascadesPerFrame ?? 0;
    if (!Number.isInteger(staticCascadesPerFrame) || staticCascadesPerFrame < 0) {
        return Promise.reject(new RangeError("enableCsmStaticCache requires a non-negative integer staticCascadesPerFrame"));
    }
    const cascadeCoveragePadding = options.cascadeCoveragePadding ?? 0;
    if (!Number.isFinite(cascadeCoveragePadding) || cascadeCoveragePadding < 0 || cascadeCoveragePadding > 1) {
        return Promise.reject(new RangeError("enableCsmStaticCache requires a cascadeCoveragePadding between 0 and 1"));
    }
    if (cascadeCoveragePadding > 0 && !(sg._config as CsmConfig)._stabilizeCascades) {
        return Promise.reject(new Error("enableCsmStaticCache cascadeCoveragePadding requires stabilizeCascades"));
    }
    // A fresh fit reaches 1 / (1 + padding) + sqrt(2) / mapSize of its disc (texel snap); 2 / mapSize keeps that below 1.
    if (cascadeCoveragePadding > 0 && cascadeCoveragePadding < 2 / sg._config._mapSize) {
        return Promise.reject(new RangeError("enableCsmStaticCache requires a cascadeCoveragePadding of at least 2 / mapSize"));
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
    sg._csmCache = {
        _refitAngle: options.refitAngle,
        _refitMaxIntervalMs: options.refitMaxIntervalMs ?? 0,
        _staticCascadesPerFrame: staticCascadesPerFrame,
        _cascadeCoveragePadding: cascadeCoveragePadding,
    };
    oldTexture.destroy();
    const promise = import("./csm-shadow-cache.js").then((module) => {
        sg._csmCache!._loaded = true;
        const config = sg._config as CsmConfig;
        const ensure: NonNullable<ShadowGenerator["_ensureShadowTaskState"]> = (eng, scene, casterMeshes) => {
            const state = module.ensureCsmShadowCacheState(eng, scene, sg, config, casterMeshes, sg._shadowTaskState ?? null);
            sg._shadowTaskState = state;
            return state;
        };
        const render: NonNullable<ShadowGenerator["_renderShadowMap"]> = (eng, state) => module.renderCsmShadowMapCached(eng, sg, state as CsmTaskState, config);
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
