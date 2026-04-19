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
import type { Mesh } from "../mesh/mesh.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import {
    buildCasters,
    syncCasterMatrices,
    drawCasters,
    shadowMatrixChanged,
    writeShadowUboFields,
    buildLightViewMatrix,
    multiply4x4,
    createDepthSceneBGL,
    createSharedShadowUBO,
    createShadowParamsUBO,
} from "./shadow-base.js";
import depthVertSrc from "../../shaders/shadow-pcf-depth.vertex.wgsl?raw";
import { registerPcfShadowShader } from "../material/standard/standard-pipeline.js";
import { registerPcfShadowBgl } from "../material/standard/standard-pipeline.js";
import { WGSL_SCENE_UNIFORMS_SHADOW } from "../shader/wgsl-helpers.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

// ─── PCF Shader Fragments (bundled only when PCF is used) ──────────

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

export interface PcfShadowGeneratorConfig {
    mapSize?: number;
    bias?: number;
    darkness?: number;
    normalBias?: number;
    /** Near plane for the shadow projection. Default: uses camera near (1). */
    near?: number;
    /** Far plane for the shadow projection. Default: uses camera far or light range. */
    far?: number;
}

/**
 * Compute a perspective view-projection matrix from a spot light.
 * FOV = spot angle, aspect = 1:1 (square shadow map).
 */
function computeSpotLightMatrix(light: SpotLight, near: number, far: number): { viewProj: Float32Array; near: number; far: number } {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z);

    // Perspective projection (column-major, WebGPU NDC z=[0,1])
    // FOV = spot angle, aspect = 1:1
    const fov = light.angle;
    const f = 1.0 / Math.tan(fov * 0.5);

    const proj = new Float32Array(16);
    proj[0] = f; // 1:1 aspect ratio
    proj[5] = f;
    proj[10] = far / (far - near);
    proj[11] = 1;
    proj[14] = -(far * near) / (far - near);
    // proj[15] = 0 (perspective divide)

    return { viewProj: multiply4x4(proj, view), near, far };
}

export function createPcfShadowGenerator(engine: EngineContext, light: SpotLight, casterMeshes: Mesh[], cfg: PcfShadowGeneratorConfig = {}): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    ensurePcfRegistered();
    const mapSize = cfg.mapSize ?? 512;
    const bias = cfg.bias ?? 0.00005;
    const darkness = cfg.darkness ?? 0;
    const normalBias = cfg.normalBias ?? 0;

    // Near/far for perspective projection — BJS uses activeCamera.minZ / maxZ
    const near = cfg.near ?? 1;
    const far = cfg.far ?? (light.range === Number.MAX_VALUE ? 10000 : light.range);

    const { viewProj } = computeSpotLightMatrix(light, near, far);

    // --- Depth pipeline BGL (needed before buildCasters) ---
    const depthMeshBGL = createSingleUniformBGL(eng, "pcf-depth-mesh", GPUShaderStage.VERTEX);

    // Build caster data + per-caster bind groups
    const casters = buildCasters(eng, casterMeshes, depthMeshBGL);

    // --- Depth-only texture ---
    const depthTexture = device.createTexture({
        label: "shadow-pcf-depth",
        size: { width: mapSize, height: mapSize },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // --- Depth pipeline (vertex-only, no fragment) ---
    const depthSceneUBO = createUniformBuffer(eng, viewProj as Float32Array<ArrayBuffer>);

    const depthSceneBGL = createDepthSceneBGL(eng, "pcf-depth-scene");

    const depthVert = device.createShaderModule({ code: WGSL_SCENE_UNIFORMS_SHADOW + depthVertSrc, label: "pcf-depth-vert" });

    const depthPipeline = device.createRenderPipeline({
        label: "shadow-pcf-depth",
        layout: device.createPipelineLayout({ bindGroupLayouts: [depthSceneBGL, depthMeshBGL] }),
        vertex: {
            module: depthVert,
            entryPoint: "main",
            buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }],
        },
        depthStencil: {
            format: "depth32float",
            depthWriteEnabled: true,
            depthCompare: "less-equal",
            depthBias: Math.round(bias * 1e7),
            depthBiasSlopeScale: normalBias > 0 ? normalBias : 2,
        },
        primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    });

    const depthSceneBG = device.createBindGroup({
        layout: depthSceneBGL,
        entries: [{ binding: 0, resource: { buffer: depthSceneUBO } }],
    });

    // --- Comparison sampler for PCF ---
    const comparisonSampler = device.createSampler({
        label: "shadow-pcf-comparison",
        compare: "less",
        magFilter: "linear",
        minFilter: "linear",
    });

    // Shadow params UBO (depthScale slot reused as texel size for PCF offsets)
    const shadowParamsUBO = createShadowParamsUBO(eng, bias, 1.0 / mapSize);

    const lightMatrix = viewProj;
    const shadowsInfo = new Float32Array([darkness, mapSize, 1.0 / mapSize, 0]);
    const depthValuesArr = new Float32Array([0, 1]);

    // Shared shadow UBO for all receiver meshes (96 bytes)
    const { ubo: sharedShadowUBO, data: shadowUboData } = createSharedShadowUBO(eng, lightMatrix, depthValuesArr, shadowsInfo);

    // Shadow matrix early-out tracking (init to -1 to force first-frame render)
    let _lastSpotLightVer = -1;
    let _lastPcfCasterVerSum = -1;

    const sg: ShadowGenerator = {
        shadowType: "pcf" as const,
        light,
        blurredTexture: depthTexture, // PCF: depth texture (not blurred)
        blurredSampler: comparisonSampler, // PCF: comparison sampler
        renderShadowMap(encoder: GPUCommandEncoder): number {
            // Check if anything has changed since last render
            let casterVerSum = 0;
            for (const c of casters) {
                casterVerSum += c._mesh.worldMatrixVersion;
            }
            const lightVer = light.worldMatrixVersion;
            const changed = lightVer !== _lastSpotLightVer || casterVerSum !== _lastPcfCasterVerSum;

            if (!changed) {
                return 0; // Nothing moved — shadow map is still valid
            }

            // Only recompute light matrix when light has moved
            if (lightVer !== _lastSpotLightVer) {
                _lastSpotLightVer = lightVer;
                const updated = computeSpotLightMatrix(light, near, far);
                if (shadowMatrixChanged(lightMatrix, updated.viewProj)) {
                    lightMatrix.set(updated.viewProj);
                    sg._version++;
                    device.queue.writeBuffer(depthSceneUBO, 0, lightMatrix as Float32Array<ArrayBuffer>);
                    // Update shared shadow UBO for all receivers
                    writeShadowUboFields(shadowUboData, sg);
                    device.queue.writeBuffer(sharedShadowUBO, 0, shadowUboData as Float32Array<ArrayBuffer>);
                }
            }
            _lastPcfCasterVerSum = casterVerSum;

            syncCasterMatrices(eng, casters);

            const dp = encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: depthTexture.createView(),
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                    depthClearValue: 1.0,
                },
            });
            dp.setPipeline(depthPipeline);
            dp.setBindGroup(0, depthSceneBG);
            drawCasters(dp, casters);
            dp.end();

            return casters.length;
        },
        lightMatrix,
        shadowsInfo,
        depthValues: depthValuesArr,
        depthMeshBGL,
        shadowParamsUBO,
        shadowUBO: sharedShadowUBO,
        config: {
            mapSize,
            depthScale: 1.0 / mapSize,
            bias,
            blurScale: 1,
            darkness,
            frustumEdgeFalloff: 0,
            orthoMinZ: near,
            orthoMaxZ: far,
        },
        _version: 0,
    };

    return sg;
}
