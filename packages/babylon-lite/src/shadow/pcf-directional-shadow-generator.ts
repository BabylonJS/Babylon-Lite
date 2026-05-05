/** PCF Shadow Generator for Directional Lights.
 *
 *  Same on-shader PCF5 sampling as `pcf-shadow-generator.ts`, but with an
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
 *  (`createShadowGenerator` → directional, `createPcfShadowGenerator` → spot).
 */

import type { DirectionalLight } from "../light/directional-light.js";
import type { Mesh } from "../mesh/mesh.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import {
    syncCasterMatrices,
    drawCasters,
    buildLightViewMatrix,
    multiply4x4,
    createSharedShadowUBO,
    createShadowParamsUBO,
    createPcfDepthSceneData,
    createShadowDepthInfra,
    createShadowDirtyTracker,
    updateShadowLightMatrix,
} from "./shadow-base.js";
import depthVertSrc from "../../shaders/shadow-pcf-depth.vertex.wgsl?raw";
import { registerPcfShadowShader, registerPcfShadowBgl } from "../material/standard/standard-flags.js";

/** Shadow-pass UBO: light view-projection plus Babylon-style PCF clip-space bias. */
const SHADOW_LIGHT_VIEW_WGSL = `struct SceneUniforms { viewProjection: mat4x4<f32>, pcfBias: vec4<f32> }\n@group(0) @binding(0) var<uniform> scene: SceneUniforms;\n`;

// Morph-aware depth vertex shader — inlined to avoid a separate import that
// would bloat non-morph scenes. Only used when a caster has morphTargets.
const DEPTH_VERT_MORPH = `struct MeshUniforms { world: mat4x4<f32> };
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
@group(1) @binding(1) var morphTargets: texture_2d<f32>;
struct morphUniforms { weights: vec4<f32>, count: u32, texWidth: u32, rowsPerBand: u32, _p0: u32 };
@group(1) @binding(2) var<uniform> morph: morphUniforms;
@vertex fn main(@location(0) position: vec3<f32>, @builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var pos = position;
  let co = vec2<i32>(i32(vertexIndex % morph.texWidth), i32(vertexIndex / morph.texWidth));
  for (var i = 0u; i < morph.count; i = i + 1u) {
    let posBase = i32(i * 2u) * i32(morph.rowsPerBand);
    pos = pos + morph.weights[i] * textureLoad(morphTargets, vec2<i32>(co.x, posBase + co.y), 0).xyz;
  }
  var clipPos = scene.viewProjection * (mesh.world * vec4<f32>(pos, 1.0));
  clipPos.z = clipPos.z + scene.pcfBias.x * clipPos.w;
  return clipPos;
}`;

// ─── Shared PCF WGSL fragments (copy of pcf-shadow-generator.ts) ───

const PCF_DECLARATIONS = `
@group(2) @binding(0) var shadowTex: texture_depth_2d;
@group(2) @binding(1) var shadowCompSampler: sampler_comparison;
`;

const PCF_FN = `
fn computeShadowWithPCF(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, mapSize: f32, invMapSize: f32) -> f32 {
  let clipSpace = posFromLight.xyz / posFromLight.w;
  let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let depthRef = clamp(clipSpace.z, 0.0, 1.0);
  var tc = uv * mapSize + 0.5;
  let st = fract(tc);
  let base = (floor(tc) - 0.5) * invMapSize;
  let uvw0 = 4.0 - 3.0 * st;
  let uvw1 = vec2<f32>(7.0);
  let uvw2 = 1.0 + 3.0 * st;
  let u = vec3<f32>((3.0 - 2.0 * st.x) / uvw0.x - 2.0, (3.0 + st.x) / uvw1.x, st.x / uvw2.x + 2.0) * invMapSize;
  let v = vec3<f32>((3.0 - 2.0 * st.y) / uvw0.y - 2.0, (3.0 + st.y) / uvw1.y, st.y / uvw2.y + 2.0) * invMapSize;
  var sh = 0.0;
  sh += uvw0.x * uvw0.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[0], v[0]), depthRef);
  sh += uvw1.x * uvw0.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[1], v[0]), depthRef);
  sh += uvw2.x * uvw0.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[2], v[0]), depthRef);
  sh += uvw0.x * uvw1.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[0], v[1]), depthRef);
  sh += uvw1.x * uvw1.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[1], v[1]), depthRef);
  sh += uvw2.x * uvw1.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[2], v[1]), depthRef);
  sh += uvw0.x * uvw2.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[0], v[2]), depthRef);
  sh += uvw1.x * uvw2.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[1], v[2]), depthRef);
  sh += uvw2.x * uvw2.y * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2<f32>(u[2], v[2]), depthRef);
  sh /= 144.0;
  return mix(darkness, 1.0, sh);
}
`;

const PCF_CALL = `  shadow = computeShadowWithPCF(input.vPositionFromLight, input.vDepthMetric, shadowInfo.shadowsInfo.x, shadowInfo.shadowsInfo.y, shadowInfo.shadowsInfo.z);\n`;

let _pcfRegistered = false;
function ensurePcfRegistered(): void {
    if (_pcfRegistered) {
        return;
    }
    _pcfRegistered = true;
    registerPcfShadowShader({ declarations: PCF_DECLARATIONS, fn: PCF_FN, call: PCF_CALL });
    registerPcfShadowBgl({ textureSampleType: "depth", samplerType: "comparison" });
}

// ─── Directional ortho projection ──────────────────────────────────

/** Compute the ortho light view-projection for a directional light, auto-fit
 *  to the caster AABBs. Mirrors `computeDirectionalLightMatrix` in
 *  `shadow-generator.ts` (ESM) so PCF and ESM share the same frustum layout. */
function computeDirectionalMatrix(light: DirectionalLight, casterMeshes: Mesh[], orthoMinZ: number, orthoMaxZ: number): { viewProj: Float32Array; near: number; far: number } {
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
    return { viewProj: multiply4x4(proj, view), near, far };
}

// ─── Public API ────────────────────────────────────────────────────

export interface PcfDirectionalShadowGeneratorConfig {
    mapSize?: number;
    bias?: number;
    darkness?: number;
    normalBias?: number;
    /** Ortho near plane. Default 1. */
    orthoMinZ?: number;
    /** Ortho far plane. Default 10000. */
    orthoMaxZ?: number;
}

export function createPcfDirectionalShadowGenerator(
    engine: EngineContext,
    light: DirectionalLight,
    casterMeshes: Mesh[],
    cfg: PcfDirectionalShadowGeneratorConfig = {}
): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    ensurePcfRegistered();
    const mapSize = cfg.mapSize ?? 1024;
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    const orthoMinZ = cfg.orthoMinZ ?? 1;
    const orthoMaxZ = cfg.orthoMaxZ ?? 10000;

    const { viewProj } = computeDirectionalMatrix(light, casterMeshes, orthoMinZ, orthoMaxZ);

    // Split casters into static (no morphs) and morphed groups so the shadow
    // depth pass applies morph target deformation to get correct shadow shapes.
    const staticMeshes: Mesh[] = [];
    const morphMeshes: Mesh[] = [];
    for (const m of casterMeshes) {
        const mt = (m as { morphTargets?: { texture: GPUTexture; weightsBuffer: GPUBuffer } | null }).morphTargets;
        if (mt) {
            morphMeshes.push(m);
        } else {
            staticMeshes.push(m);
        }
    }

    // Static (non-morphed) depth infra — standard position-only vertex shader.
    const staticInfra =
        staticMeshes.length > 0
            ? createShadowDepthInfra(eng, {
                  label: "shadow-pcf-dir",
                  viewProj,
                  depthSceneData: createPcfDepthSceneData(viewProj, bias),
                  casterMeshes: staticMeshes,
                  vertCode: SHADOW_LIGHT_VIEW_WGSL + depthVertSrc,
              })
            : null;

    // Morphed depth infra — vertex shader samples the morph atlas texture.
    // Each morphed caster gets its own depth infra since each needs its own
    // morph texture/UBO bindings in group 1.
    const morphInfra =
        morphMeshes.length > 0
            ? (() => {
                  const morphBglEntries: GPUBindGroupLayoutEntry[] = [
                      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
                      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: 32 } },
                  ];
                  return morphMeshes.map((mesh) => {
                      const mt = (mesh as { morphTargets?: { texture: GPUTexture; weightsBuffer: GPUBuffer } }).morphTargets!;
                      const inf = createShadowDepthInfra(eng, {
                          label: "shadow-pcf-dir-morph",
                          viewProj,
                          depthSceneData: createPcfDepthSceneData(viewProj, bias),
                          casterMeshes: [mesh],
                          vertCode: SHADOW_LIGHT_VIEW_WGSL + DEPTH_VERT_MORPH,
                          extraMeshBglEntries: morphBglEntries,
                          extraMeshEntries: [
                              { binding: 1, resource: mt.texture.createView() },
                              { binding: 2, resource: { buffer: mt.weightsBuffer } },
                          ],
                      });
                      return inf;
                  });
              })()
            : [];

    // Unified caster list for dirty tracking and matrix sync.
    const allCasters = [...(staticInfra?.casters ?? []), ...morphInfra.flatMap((m) => m.casters)];
    const depthSceneUBO = staticInfra?.depthSceneUBO ?? morphInfra[0]!.depthSceneUBO;

    const depthTexture = device.createTexture({
        label: "shadow-pcf-dir-depth",
        size: { width: mapSize, height: mapSize },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const comparisonSampler = device.createSampler({
        label: "shadow-pcf-dir-comparison",
        compare: "less",
        magFilter: "linear",
        minFilter: "linear",
    });

    const shadowParamsUBO = createShadowParamsUBO(eng, bias, 1.0 / mapSize);
    const lightMatrix = viewProj;
    const shadowsInfo = new Float32Array([darkness, mapSize, 1.0 / mapSize, 0]);
    const depthValuesArr = new Float32Array([0, 1]);
    const { ubo: sharedShadowUBO, data: shadowUboData } = createSharedShadowUBO(eng, lightMatrix, depthValuesArr, shadowsInfo);
    const dirtyTracker = createShadowDirtyTracker();

    const sg: ShadowGenerator = {
        shadowType: "pcf" as const,
        light,
        blurredTexture: depthTexture,
        blurredSampler: comparisonSampler,
        renderShadowMap(encoder: GPUCommandEncoder): number {
            const { dirty, lightChanged } = dirtyTracker.check(light, allCasters);
            if (!dirty) {
                return 0;
            }
            if (lightChanged) {
                const updated = computeDirectionalMatrix(light, casterMeshes, orthoMinZ, orthoMaxZ);
                updateShadowLightMatrix(eng, sg, depthSceneUBO, updated.viewProj, shadowUboData);
                // Also update scene UBOs for morphed infras if they have their own.
                for (const mi of morphInfra) {
                    if (mi.depthSceneUBO !== depthSceneUBO) {
                        eng.device.queue.writeBuffer(mi.depthSceneUBO, 0, updated.viewProj as Float32Array<ArrayBuffer>);
                    }
                }
            }
            dirtyTracker.commit(light, allCasters);

            syncCasterMatrices(eng, allCasters);
            const dp = encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: depthTexture.createView(),
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                    depthClearValue: 1.0,
                },
            });
            // Draw static casters with the standard depth pipeline.
            if (staticInfra) {
                dp.setPipeline(staticInfra.depthPipeline);
                dp.setBindGroup(0, staticInfra.depthSceneBG);
                drawCasters(dp, staticInfra.casters);
            }
            // Draw morphed casters with the morph-aware depth pipeline.
            for (const mi of morphInfra) {
                dp.setPipeline(mi.depthPipeline);
                dp.setBindGroup(0, mi.depthSceneBG);
                drawCasters(dp, mi.casters);
            }
            dp.end();
            return allCasters.length;
        },
        lightMatrix,
        shadowsInfo,
        depthValues: depthValuesArr,
        depthMeshBGL: staticInfra?.depthMeshBGL ?? morphInfra[0]!.depthMeshBGL,
        shadowParamsUBO,
        shadowUBO: sharedShadowUBO,
        config: {
            mapSize,
            depthScale: 1.0 / mapSize,
            bias,
            blurKernel: 1,
            blurScale: 1,
            darkness,
            frustumEdgeFalloff: 0,
            orthoMinZ,
            orthoMaxZ,
        },
        _version: 0,
    };

    return sg;
}
