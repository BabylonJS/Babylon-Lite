/** PCF Shadow Generator for Directional Lights.
 *
 *  Same on-shader PCF5 sampling as `pcf-spotlight-shadow-generator.ts`, but with an
 *  orthographic light projection fit to the caster AABBs — matching Babylon's
 *  DirectionalLight + `usePercentageCloserFiltering=true` configuration.
 *
 *  Everything downstream of the projection (depth-only pipeline, comparison
 *  sampler, shared UBOs, dirty tracking) is identical to the spot-light PCF
 *  path. The only differences are:
 *    1. The projection matrix (ortho vs perspective).
 *    2. The projection bounds auto-fit based on casters' world AABBs.
 *
 *  Exported separately so scenes that only use spot-PCF don't pull in the
 *  directional AABB-fit code path, and so the API parallels the ESM split
 *  (`createEsmDirectionalShadowGenerator` → directional ESM, `createPcfSpotlightShadowGenerator` → spot PCF).
 */

import { F32 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { computeDirectionalLightMatrix, createSharedShadowUBO, createShadowParamsUBO } from "./shadow-base.js";
import { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap, type PcfTaskState } from "./pcf-shadow-task-hooks.js";

/** Configuration for a directional-light PCF shadow generator: map size, depth bias, darkness, and ortho projection bounds. */
export interface PcfDirectionalShadowGeneratorConfig {
    mapSize?: number;
    bias?: number;
    darkness?: number;
    normalBias?: number;
    /** Ortho near plane. Default 1. */
    orthoMinZ?: number;
    /** Ortho far plane. Default 10000. */
    orthoMaxZ?: number;
    /** Force the shadow map to be regenerated every frame. Default false. */
    forceRefreshEveryFrame?: boolean;
}

/**
 * Creates a PCF (percentage-closer filtering) shadow generator for a directional light,
 * using an orthographic projection auto-fit to the caster meshes' world AABBs.
 * @param engine - The engine providing the GPU device.
 * @param _light - The directional light that casts the shadows.
 * @param cfg - Optional shadow-map and projection configuration.
 * @returns A `ShadowGenerator` wired to the directional PCF render path.
 */
export function createPcfDirectionalShadowGenerator(engine: EngineContext, _light: DirectionalLight, cfg: PcfDirectionalShadowGeneratorConfig = {}): ShadowGenerator {
    const device = engine._device;
    const mapSize = cfg.mapSize ?? 1024;
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    const orthoMinZ = cfg.orthoMinZ ?? 1;
    const orthoMaxZ = cfg.orthoMaxZ ?? 10000;
    const forceRefreshEveryFrame = cfg.forceRefreshEveryFrame ?? false;

    const _lightMatrix = new F32(16);
    const _shadowsInfo = new F32([darkness, mapSize, 1.0 / mapSize, 0]);
    const _depthValues = new F32([0, 1]);
    const { ubo: _shadowUBO } = createSharedShadowUBO(engine, _lightMatrix, _depthValues, _shadowsInfo);
    const _config: ShadowGenerator["_config"] = {
        _mapSize: mapSize,
        _bias: bias,
        _forceRefreshEveryFrame: forceRefreshEveryFrame,
        _orthoMinZ: orthoMinZ,
        _orthoMaxZ: orthoMaxZ,
    };

    const sg: ShadowGenerator = {
        _shadowType: "pcf" as const,
        _light,
        _depthTexture: device.createTexture({
            size: { width: mapSize, height: mapSize },
            format: "depth32float",
            usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
        }),
        _depthSampler: device.createSampler({
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
        }),
        _lightMatrix,
        _shadowsInfo,
        _depthValues,
        _shadowParamsUBO: createShadowParamsUBO(engine, bias, 1.0 / mapSize),
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
        return renderPcfShadowMap(engine, sg, state as PcfTaskState, (casterMeshes, offX, offY, offZ) =>
            computeDirectionalLightMatrix(_light, casterMeshes, orthoMinZ, orthoMaxZ, offX, offY, offZ)
        );
    };
    return sg;
}
