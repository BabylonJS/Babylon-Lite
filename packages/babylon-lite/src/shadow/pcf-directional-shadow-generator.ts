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

import type { DirectionalLight } from "../light/directional-light.js";
import type { Mesh } from "../mesh/mesh.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { buildLightViewMatrix, createSharedShadowUBO, createShadowParamsUBO, multiply4x4 } from "./shadow-base.js";
import { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap, type PcfLightMatrix, type PcfTaskState } from "./pcf-shadow-task-hooks.js";

// ─── Internal helpers ───────────────────────────────────────────────

/** @internal Compute the PCF directional light view/projection matrix for ShadowTask. */
function _computeDirectionalLightMatrix(light: DirectionalLight, casterMeshes: readonly Mesh[], orthoMinZ: number, orthoMaxZ: number): PcfLightMatrix {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z);
    let lMinX = Infinity,
        lMaxX = -Infinity,
        lMinY = Infinity,
        lMaxY = -Infinity;
    for (const mesh of casterMeshes) {
        const world = mesh.worldMatrix;
        const bmin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
        const bmax = mesh.boundMax ?? [0.5, 0.5, 0.5];
        for (let ci = 0; ci < 8; ci++) {
            const lx = ci & 1 ? bmax[0] : bmin[0];
            const ly = ci & 2 ? bmax[1] : bmin[1];
            const lz = ci & 4 ? bmax[2] : bmin[2];
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
            const vx = view[0]! * wx + view[4]! * wy + view[8]! * wz + view[12]!;
            const vy = view[1]! * wx + view[5]! * wy + view[9]! * wz + view[13]!;
            lMinX = Math.min(lMinX, vx);
            lMaxX = Math.max(lMaxX, vx);
            lMinY = Math.min(lMinY, vy);
            lMaxY = Math.max(lMaxY, vy);
        }
    }
    if (!Number.isFinite(lMinX)) {
        lMinX = -1;
        lMaxX = 1;
        lMinY = -1;
        lMaxY = 1;
    }
    const sx = (lMaxX - lMinX) * 0.1;
    const sy = (lMaxY - lMinY) * 0.1;
    lMinX -= sx;
    lMaxX += sx;
    lMinY -= sy;
    lMaxY += sy;

    const near = orthoMinZ;
    const far = orthoMaxZ;
    const proj = new Float32Array(16);
    proj[0] = 2 / (lMaxX - lMinX);
    proj[5] = 2 / (lMaxY - lMinY);
    proj[10] = 1 / (far - near);
    proj[12] = -(lMaxX + lMinX) / (lMaxX - lMinX);
    proj[13] = -(lMaxY + lMinY) / (lMaxY - lMinY);
    proj[14] = -near / (far - near);
    proj[15] = 1;
    return { _view: view, _viewProj: multiply4x4(proj, view), _near: near, _far: far };
}

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

export function createPcfDirectionalShadowGenerator(engine: EngineContext, _light: DirectionalLight, cfg: PcfDirectionalShadowGeneratorConfig = {}): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    const mapSize = cfg.mapSize ?? 1024;
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    const orthoMinZ = cfg.orthoMinZ ?? 1;
    const orthoMaxZ = cfg.orthoMaxZ ?? 10000;
    const forceRefreshEveryFrame = cfg.forceRefreshEveryFrame ?? false;

    const _lightMatrix = new Float32Array(16);
    const _shadowsInfo = new Float32Array([darkness, mapSize, 1.0 / mapSize, 0]);
    const _depthValues = new Float32Array([0, 1]);
    const { ubo: _shadowUBO } = createSharedShadowUBO(eng, _lightMatrix, _depthValues, _shadowsInfo);
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
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
        _depthSampler: device.createSampler({
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
        }),
        _lightMatrix,
        _shadowsInfo,
        _depthValues,
        _shadowParamsUBO: createShadowParamsUBO(eng, bias, 1.0 / mapSize),
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
        return renderPcfShadowMap(engine, sg, state as PcfTaskState, (casterMeshes) => _computeDirectionalLightMatrix(_light, casterMeshes, orthoMinZ, orthoMaxZ));
    };
    return sg;
}
