/**
 * PCF Shadow Generator — Percentage Closer Filtering for spot lights.
 *
 * Pipeline (per frame):
 *   1. Render shadow casters to depth-only texture from light's perspective
 *   2. Main-pass fragment shader samples depth with comparison sampler (PCF5 — 5×5 bilinear)
 *
 * Compared to the ESM generator:
 *   - No blur passes (saves 2 draw calls + 2 GPU textures)
 *   - depth32float depth-only texture (no rgba16float color)
 *   - Smaller shadow maps work well (512 default)
 *   - Uses hardware depth comparison + averaging for soft edges
 *
 * Matches Babylon.js ShadowGenerator with:
 *   - usePercentageCloserFiltering = true (SM_PCF / shadow5 quality)
 */

import type { SpotLight } from "../light/spot-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { buildLightViewMatrix, createSharedShadowUBO, createShadowParamsUBO, multiply4x4 } from "./shadow-base.js";
import { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap, type PcfLightMatrix, type PcfTaskState } from "./pcf-shadow-task-hooks.js";

export interface PcfSpotlightShadowGeneratorConfig {
    mapSize?: number;
    bias?: number;
    darkness?: number;
    normalBias?: number;
    /** Near plane for the shadow projection. Default: uses camera near (1). */
    near?: number;
    /** Far plane for the shadow projection. Default: uses camera far or light range. */
    far?: number;
    /** Force the shadow map to be regenerated every frame. Default false. */
    forceRefreshEveryFrame?: boolean;
}

/** @internal Compute the PCF spot-light view/projection matrix for ShadowTask. */
export function _computeSpotLightMatrix(light: SpotLight, near: number, far: number): PcfLightMatrix {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z);
    const f = 1.0 / Math.tan(light.angle * 0.5);
    const proj = new Float32Array(16);
    proj[0] = f;
    proj[5] = f;
    proj[10] = far / (far - near);
    proj[11] = 1;
    proj[14] = -(far * near) / (far - near);
    return { _view: view, _viewProj: multiply4x4(proj, view), _near: near, _far: far };
}

export function createPcfSpotlightShadowGenerator(engine: EngineContext, _light: SpotLight, cfg: PcfSpotlightShadowGeneratorConfig = {}): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    const mapSize = cfg.mapSize ?? 512;
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    // Near/far for perspective projection — BJS uses activeCamera.minZ / maxZ
    const near = cfg.near ?? 1;
    const far = cfg.far ?? (_light.range === Number.MAX_VALUE ? 10000 : _light.range);

    // --- Depth-only texture ---
    const _depthTexture = device.createTexture({
        size: { width: mapSize, height: mapSize },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    // --- Comparison sampler for PCF ---
    const _depthSampler = device.createSampler({
        compare: "less",
        magFilter: "linear",
        minFilter: "linear",
    });

    // Shadow params UBO (depthScale slot reused as texel size for PCF offsets)
    const _shadowParamsUBO = createShadowParamsUBO(eng, bias, 1.0 / mapSize);

    const _lightMatrix = new Float32Array(16);
    const _shadowsInfo = new Float32Array([darkness, mapSize, 1.0 / mapSize, 0]);
    const _depthValues = new Float32Array([0, far]);

    // Shared shadow UBO for all receiver meshes (96 bytes)
    const { ubo: _shadowUBO } = createSharedShadowUBO(eng, _lightMatrix, _depthValues, _shadowsInfo);
    const _config: ShadowGenerator["_config"] = {
        _mapSize: mapSize,
        _bias: bias,
        _forceRefreshEveryFrame: cfg.forceRefreshEveryFrame ?? false,
    };

    const sg: ShadowGenerator = {
        _shadowType: "pcf",
        _light,
        _depthTexture,
        _depthSampler,
        _lightMatrix,
        _shadowsInfo,
        _depthValues,
        _shadowParamsUBO,
        _shadowUBO,
        _config,
        _version: 0,
    };
    sg._preloadShadowTask = preloadPcfShadowTaskState;
    sg._ensureShadowTaskState = (engine, scene, casterMeshes) => {
        const state = ensurePcfShadowTaskState(engine, scene, sg, casterMeshes, sg._shadowTaskState ?? null);
        sg._shadowTaskState = state;
        return state;
    };
    sg._renderShadowMap = (engine, state) => {
        return renderPcfShadowMap(engine, sg, state as PcfTaskState, () => _computeSpotLightMatrix(_light, near, far));
    };
    return sg;
}
