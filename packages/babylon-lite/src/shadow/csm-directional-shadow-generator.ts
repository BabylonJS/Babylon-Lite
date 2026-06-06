/** Cascaded Shadow Map (CSM) generator for directional lights.
 *
 *  Renders the scene depth into N cascade layers of a `depth32float`
 *  `texture_2d_array`, each fit to a successive slice of the camera frustum
 *  (logarithmic/uniform split blend), and exposes a single large receiver UBO
 *  holding the N cascade transforms + split distances. The receiver
 *  (`csm-shadow-fragment-core`) selects a cascade per fragment and samples it
 *  with a 5×5 PCF kernel — matching Babylon.js `CascadedShadowGenerator` with
 *  the default PCF5 filter.
 *
 *  All substantive CSM code lives in this module + `csm-shadow-task-hooks.ts` +
 *  `csm-shadow-fragment-core.ts`, fetched only by scenes that create a CSM
 *  generator, so ESM/PCF scenes are byte-unaffected.
 */

import type { DirectionalLight } from "../light/directional-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { createShadowParamsUBO } from "./shadow-base.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import { ensureCsmShadowTaskState, preloadCsmShadowTaskState, renderCsmShadowMap, type CsmConfig, type CsmTaskState } from "./csm-shadow-task-hooks.js";
import { setCsmStdReceiverFactory, setCsmPbrReceiverFactory } from "./csm-receiver-registry.js";
import { createStdCsmShadowFragment } from "../material/standard/fragments/std-csm-shadow-fragment.js";
import { createPbrCsmShadowFragment } from "../material/pbr/fragments/pbr-csm-shadow-fragment.js";

/** Configuration for a directional-light cascaded shadow generator. */
export interface CsmDirectionalShadowGeneratorConfig {
    /** Shadow map resolution per cascade (square). Default 1024. */
    mapSize?: number;
    /** Number of cascades. Default 4 (max 4). */
    numCascades?: number;
    /** Split blend between logarithmic and uniform partitioning, 0..1. Default 0.5. */
    lambda?: number;
    /** Fraction of a cascade used to cross-fade into the next one. Default 0.1. Set 0 to disable blending. */
    cascadeBlendPercentage?: number;
    /** Use a stable bounding-sphere fit (no shimmering) instead of a tight AABB fit. Default false. */
    stabilizeCascades?: boolean;
    /** Maximum shadow distance in world units. Default = camera far plane. */
    shadowMaxZ?: number;
    /** Depth bias added during shadow-map generation. Default 0.00005. */
    bias?: number;
    /** Shadow darkness (0 = black shadow, 1 = no shadow). Default 0. */
    darkness?: number;
    /** Soft fade-out at the edge of each cascade frustum, 0..1. Default 0. */
    frustumEdgeFalloff?: number;
    /** Regenerate every cascade every frame even when nothing moved. Default false. */
    forceRefreshEveryFrame?: boolean;
}

/**
 * Creates a cascaded shadow map (CSM) generator for a directional light.
 *
 * The shadow map is a `depth32float` `texture_2d_array` with one layer per
 * cascade; each cascade is fit to a logarithmic/uniform slice of the active
 * camera frustum and sampled on the receiver with a 5×5 PCF kernel. Casters are
 * supplied via {@link setShadowTaskCasterMeshes} and the receiver is any mesh
 * with `receiveShadows = true`.
 *
 * @param engine - The engine providing the GPU device.
 * @param _light - The directional light that casts the shadows.
 * @param cfg - Optional cascade, map-size and bias configuration.
 * @returns A `ShadowGenerator` wired to the CSM render path.
 */
export function createCsmDirectionalShadowGenerator(engine: EngineContext, _light: DirectionalLight, cfg: CsmDirectionalShadowGeneratorConfig = {}): ShadowGenerator {
    // Register the material-family CSM receiver fragments lazily — only scenes that
    // create a CSM generator pull the cascade-receiver WGSL into their bundle.
    setCsmStdReceiverFactory(createStdCsmShadowFragment);
    setCsmPbrReceiverFactory(createPbrCsmShadowFragment);

    const device = engine._device;
    const mapSize = cfg.mapSize ?? 1024;
    const numCascades = Math.min(cfg.numCascades ?? 4, 4);
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    const frustumEdgeFalloff = cfg.frustumEdgeFalloff ?? 0;

    const csmCfg: CsmConfig = {
        _numCascades: numCascades,
        _lambda: cfg.lambda ?? 0.5,
        _cascadeBlendPercentage: cfg.cascadeBlendPercentage ?? 0.1,
        _stabilizeCascades: cfg.stabilizeCascades ?? false,
        _depthClamp: false,
        _shadowMaxZ: cfg.shadowMaxZ ?? null,
        _bias: bias,
        _darkness: darkness,
        _frustumEdgeFalloff: frustumEdgeFalloff,
        _mapSize: mapSize,
        _forceRefreshEveryFrame: cfg.forceRefreshEveryFrame ?? false,
    };

    const depthTexture = device.createTexture({
        size: { width: mapSize, height: mapSize, depthOrArrayLayers: numCascades },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const _shadowsInfo = new Float32Array([darkness, mapSize, 1.0 / mapSize, frustumEdgeFalloff]);

    const sg: ShadowGenerator = {
        _shadowType: "csm" as const,
        _light,
        _depthTexture: depthTexture,
        _depthSampler: device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" }),
        _lightMatrix: new Float32Array(16),
        _shadowsInfo,
        _depthValues: new Float32Array([0, 1]),
        _shadowParamsUBO: createShadowParamsUBO(engine, bias, 1.0 / mapSize),
        _shadowUBO: createUniformBuffer(engine, new Float32Array(80)),
        _config: {
            _mapSize: mapSize,
            _bias: bias,
            _forceRefreshEveryFrame: csmCfg._forceRefreshEveryFrame,
        },
        _version: 0,
        _csmCascadeCount: numCascades,
    };

    sg._preloadShadowTask = preloadCsmShadowTaskState;
    sg._ensureShadowTaskState = (eng, scene, casterMeshes) => {
        const state = ensureCsmShadowTaskState(eng, scene, sg, csmCfg, casterMeshes, sg._shadowTaskState ?? null);
        sg._shadowTaskState = state;
        return state;
    };
    sg._renderShadowMap = (eng, state) => renderCsmShadowMap(eng, sg, state as CsmTaskState, csmCfg);
    return sg;
}

/**
 * Register a callback fired each frame the CSM cascades are recomputed, right after the receiver
 * UBO is updated and uploaded — and before the shadow map and main pass are rendered.
 *
 * Custom `ShaderMaterial` receivers that mirror the cascade transforms into their own uniforms
 * (rather than binding the generator's receiver UBO directly, as the built-in standard/PBR/node
 * receivers do) MUST sync from inside this callback. Syncing from an `onBeforeRender` callback
 * reads the *previous* frame's transforms — a one-frame lag that makes those shadows visibly swim
 * while the camera moves (the cascade window can slide many texels per frame during a zoom).
 *
 * Multiple receivers may register on the same generator; every registered callback is invoked each
 * frame. The callback receives the 80-float receiver UBO (layout: four `mat4x4` cascade transforms,
 * `viewFrustumZ`, `frustumLengths`, `shadowsInfo`, `csmParams` — see the cascaded-shadow
 * architecture doc). The array is reused each frame; copy what you need.
 *
 * @param sg - A cascaded-shadow generator from {@link createCsmDirectionalShadowGenerator}.
 * @param cb - Receiver-sync callback.
 * @returns A disposer that unregisters this callback.
 */
export function onCsmReceiverUpdate(sg: ShadowGenerator, cb: (data: Float32Array) => void): () => void {
    (sg._onReceiverData ??= []).push(cb);
    return () => {
        const list = sg._onReceiverData;
        if (!list) {
            return;
        }
        const i = list.indexOf(cb);
        if (i >= 0) {
            list.splice(i, 1);
        }
    };
}
