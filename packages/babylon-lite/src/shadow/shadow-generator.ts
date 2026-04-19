/**
 * ShadowGenerator — Exponential Shadow Map (ESM) with Gaussian blur.
 *
 * Pipeline (per frame):
 *   1. Render shadow casters to depth texture from light's perspective (rgba16float)
 *   2. Gaussian blur X pass (1024 → 512, blurScale=2)
 *   3. Gaussian blur Y pass (512 → 512)
 *   4. Final blurred ESM texture used in main pass for shadow sampling
 *
 * Matches Babylon.js ShadowGenerator with:
 *   - useBlurExponentialShadowMap = true
 *   - useKernelBlur = true
 *   - blurKernel = 64
 *   - mapSize = 1024
 *   - depthScale = 50
 *   - bias = 0.00005
 */

import type { DirectionalLight } from "../light/directional-light.js";
import type { Mesh } from "../mesh/mesh.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
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
    createShadowParamsUBO,
    createSharedShadowUBO,
} from "./shadow-base.js";
import depthVertSrc from "../../shaders/shadow-depth.vertex.wgsl?raw";
import depthFragSrc from "../../shaders/shadow-depth.fragment.wgsl?raw";
import blurVertSrc from "../../shaders/shadow-blur.vertex.wgsl?raw";
import blurFragSrc from "../../shaders/shadow-blur.fragment.wgsl?raw";
import { WGSL_SCENE_UNIFORMS_SHADOW } from "../shader/wgsl-helpers.js";

export interface ShadowGeneratorConfig {
    mapSize?: number;
    depthScale?: number;
    bias?: number;
    blurScale?: number;
    darkness?: number;
    frustumEdgeFalloff?: number;
    /** Ortho projection min Z — typically camera.nearPlane. Default 1. */
    orthoMinZ?: number;
    /** Ortho projection max Z — typically camera.farPlane. Default 10000. */
    orthoMaxZ?: number;
}

export type { ShadowCaster as ShadowCasterMesh } from "./shadow-base.js";

export interface ShadowGenerator {
    /** Shadow technique: 'esm' (exponential, default) or 'pcf' (percentage closer filtering). */
    shadowType: "esm" | "pcf";
    /** The light that owns this shadow generator. */
    light: import("../light/types.js").LightBase;
    blurredTexture: GPUTexture;
    blurredSampler: GPUSampler;
    renderShadowMap: (encoder: GPUCommandEncoder) => number;
    lightMatrix: Float32Array;
    shadowsInfo: Float32Array;
    depthValues: Float32Array;
    depthMeshBGL: GPUBindGroupLayout;
    shadowParamsUBO: GPUBuffer;
    /** Shared shadow UBO (96 bytes) for receiver meshes: lightMatrix(16) + depthValues(4) + shadowsInfo(4).
     *  Updated once per version bump; all receivers bind this same buffer. */
    shadowUBO: GPUBuffer;
    config: Required<ShadowGeneratorConfig>;
    /** Monotonically increasing version — bumped each time lightMatrix/shadowsInfo/depthValues changes.
     *  Consumers compare against a stashed version to skip redundant UBO uploads. */
    _version: number;
}

/**
 * Compute the light's view-projection matrix for a directional light.
 *
 * Matches Babylon.js DirectionalLight._setDefaultAutoExtendShadowProjectionMatrix:
 *   - X/Y bounds from caster world AABBs transformed to light space (expanded by shadowOrthoScale=0.1)
 *   - Z bounds from camera near/far (orthoMinZ, orthoMaxZ)
 */
function computeDirectionalLightMatrix(light: DirectionalLight, casterMeshes: Mesh[], orthoMinZ: number, orthoMaxZ: number): { viewProj: Float32Array; near: number; far: number } {
    const view = buildLightViewMatrix(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z);

    // Transform each caster's world AABB corners to light space for X/Y bounds
    // Matches BJS: iterates boundingBox.vectorsWorld through viewMatrix
    let lMinX = Infinity,
        lMaxX = -Infinity;
    let lMinY = Infinity,
        lMaxY = -Infinity;

    for (const mesh of casterMeshes) {
        const world = mesh.worldMatrix;
        // Local AABB — default to unit cube if not set
        const bmin = mesh.boundMin ?? [-0.5, -0.5, -0.5];
        const bmax = mesh.boundMax ?? [0.5, 0.5, 0.5];

        // 8 corners of local AABB → world → light space
        for (let ci = 0; ci < 8; ci++) {
            const lx = ci & 1 ? bmax[0] : bmin[0];
            const ly = ci & 2 ? bmax[1] : bmin[1];
            const lz = ci & 4 ? bmax[2] : bmin[2];

            // Local → World (world is column-major 4x4)
            const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;

            // World → Light space
            const vx = view[0]! * wx + view[4]! * wy + view[8]! * wz + view[12]!;
            const vy = view[1]! * wx + view[5]! * wy + view[9]! * wz + view[13]!;
            lMinX = Math.min(lMinX, vx);
            lMaxX = Math.max(lMaxX, vx);
            lMinY = Math.min(lMinY, vy);
            lMaxY = Math.max(lMaxY, vy);
        }
    }

    // Expand by shadowOrthoScale (default 0.1) — matches Babylon
    const sx = (lMaxX - lMinX) * 0.1;
    const sy = (lMaxY - lMinY) * 0.1;
    lMinX -= sx;
    lMaxX += sx;
    lMinY -= sy;
    lMaxY += sy;

    // Z bounds from camera near/far (matching Babylon's default behavior)
    const near = orthoMinZ;
    const far = orthoMaxZ;

    // Orthographic projection (column-major, WebGPU NDC z=[0,1])
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

export function createShadowGenerator(engine: EngineContext, light: DirectionalLight, casterMeshes: Mesh[], cfg: ShadowGeneratorConfig = {}): ShadowGenerator {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    const mapSize = cfg.mapSize ?? 1024;
    const depthScale = cfg.depthScale ?? 50;
    const bias = cfg.bias ?? 0.00005;
    const blurScale = cfg.blurScale ?? 2;
    const darkness = cfg.darkness ?? 0;
    const frustumEdgeFalloff = cfg.frustumEdgeFalloff ?? 0;
    const orthoMinZ = cfg.orthoMinZ ?? 1;
    const orthoMaxZ = cfg.orthoMaxZ ?? 10000;
    const blurSize = mapSize / blurScale;

    const config: Required<ShadowGeneratorConfig> = {
        mapSize,
        depthScale,
        bias,
        blurScale,
        darkness,
        frustumEdgeFalloff,
        orthoMinZ,
        orthoMaxZ,
    };

    const { viewProj } = computeDirectionalLightMatrix(light, casterMeshes, orthoMinZ, orthoMaxZ);

    // --- Shadow depth pipeline BGLs (needed before buildCasters) ---
    const depthMeshBGL = device.createBindGroupLayout({
        label: "shadow-depth-mesh",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
    });

    // Shadow params UBO — depthValues = (0, 1) for WebGPU DirectionalLight (isNDCHalfZRange)
    const shadowParamsUBO = createShadowParamsUBO(eng, bias, depthScale);

    // Build caster data + per-caster bind groups
    const casters = buildCasters(eng, casterMeshes, depthMeshBGL, [{ binding: 1, resource: { buffer: shadowParamsUBO } }]);

    // --- Textures ---
    const esmTexture = device.createTexture({
        label: "shadow-esm",
        size: { width: mapSize, height: mapSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const depthBuf = device.createTexture({
        label: "shadow-depth-buf",
        size: { width: mapSize, height: mapSize },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const blurTexH = device.createTexture({
        label: "shadow-blur-h",
        size: { width: blurSize, height: blurSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const blurTexV = device.createTexture({
        label: "shadow-blur-v",
        size: { width: blurSize, height: blurSize },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // --- Shadow depth pipeline ---
    const depthSceneUBO = createUniformBuffer(eng, viewProj as Float32Array<ArrayBuffer>);

    const depthSceneBGL = createDepthSceneBGL(eng, "shadow-depth-scene");

    const depthVert = device.createShaderModule({ code: WGSL_SCENE_UNIFORMS_SHADOW + depthVertSrc, label: "shadow-depth-vert" });
    const depthFrag = device.createShaderModule({ code: depthFragSrc, label: "shadow-depth-frag" });

    const depthPipeline = device.createRenderPipeline({
        label: "shadow-depth",
        layout: device.createPipelineLayout({ bindGroupLayouts: [depthSceneBGL, depthMeshBGL] }),
        vertex: {
            module: depthVert,
            entryPoint: "main",
            buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }],
        },
        fragment: {
            module: depthFrag,
            entryPoint: "main",
            targets: [{ format: "rgba16float" }],
        },
        depthStencil: {
            format: "depth32float",
            depthWriteEnabled: true,
            depthCompare: "less-equal",
        },
        primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
    });

    const depthSceneBG = device.createBindGroup({
        layout: depthSceneBGL,
        entries: [{ binding: 0, resource: { buffer: depthSceneUBO } }],
    });

    // --- Blur pipeline ---
    const blurVert = device.createShaderModule({ code: blurVertSrc, label: "shadow-blur-vert" });
    const blurFrag = device.createShaderModule({ code: blurFragSrc, label: "shadow-blur-frag" });

    const blurBGL = device.createBindGroupLayout({
        label: "shadow-blur",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
    });

    const blurPipeline = device.createRenderPipeline({
        label: "shadow-blur",
        layout: device.createPipelineLayout({ bindGroupLayouts: [blurBGL] }),
        vertex: { module: blurVert, entryPoint: "main" },
        fragment: {
            module: blurFrag,
            entryPoint: "main",
            targets: [{ format: "rgba16float" }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
    });

    const blurSampler = getOrCreateSampler(eng, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

    // Blur H params — delta in output (blurSize) texel space, matching BJS PostProcess
    const blurHData = new Float32Array([1.0 / blurSize, 0, 0, 0]);
    const blurHUBO = createUniformBuffer(eng, blurHData);
    const blurHBG = device.createBindGroup({
        layout: blurBGL,
        entries: [
            { binding: 0, resource: { buffer: blurHUBO } },
            { binding: 1, resource: esmTexture.createView() },
            { binding: 2, resource: blurSampler },
        ],
    });

    // Blur V params
    const blurVData = new Float32Array([0, 1.0 / blurSize, 0, 0]);
    const blurVUBO = createUniformBuffer(eng, blurVData);
    const blurVBG = device.createBindGroup({
        layout: blurBGL,
        entries: [
            { binding: 0, resource: { buffer: blurVUBO } },
            { binding: 1, resource: blurTexH.createView() },
            { binding: 2, resource: blurSampler },
        ],
    });

    const outputSampler = getOrCreateSampler(eng, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

    const lightMatrix = viewProj;
    const shadowsInfo = new Float32Array([darkness, 0, depthScale, frustumEdgeFalloff]);
    // depthValues = (0, 1) matching Babylon's DirectionalLight for WebGPU
    const depthValuesArr = new Float32Array([0, 1]);

    // Shared shadow UBO for all receiver meshes (96 bytes)
    const { ubo: sharedShadowUBO, data: shadowUboData } = createSharedShadowUBO(eng, lightMatrix, depthValuesArr, shadowsInfo);

    // Shadow matrix early-out tracking (init to -1 to force first-frame render)
    let _lastLightVer = -1;
    let _lastCasterVerSum = -1;
    let _lastCasterCount = -1;

    const sg: ShadowGenerator = {
        shadowType: "esm" as const,
        light,
        blurredTexture: blurTexV,
        blurredSampler: outputSampler,
        renderShadowMap: null!,
        lightMatrix,
        shadowsInfo,
        depthValues: depthValuesArr,
        depthMeshBGL,
        shadowParamsUBO,
        shadowUBO: sharedShadowUBO,
        config,
        _version: 0,
    };

    sg.renderShadowMap = function renderShadowMap(encoder: GPUCommandEncoder): number {
        let casterVerSum = 0;
        for (const c of casters) {
            casterVerSum += c._mesh.worldMatrixVersion;
        }
        const lv = light.worldMatrixVersion;
        if (lv === _lastLightVer && casterVerSum === _lastCasterVerSum && casters.length === _lastCasterCount) {
            return 0;
        }
        if (lv !== _lastLightVer || casters.length !== _lastCasterCount) {
            const updated = computeDirectionalLightMatrix(light, casterMeshes, orthoMinZ, orthoMaxZ);
            if (shadowMatrixChanged(lightMatrix, updated.viewProj)) {
                lightMatrix.set(updated.viewProj);
                sg._version++;
                device.queue.writeBuffer(depthSceneUBO, 0, lightMatrix as Float32Array<ArrayBuffer>);
                writeShadowUboFields(shadowUboData, sg);
                device.queue.writeBuffer(sharedShadowUBO, 0, shadowUboData as Float32Array<ArrayBuffer>);
            }
        }
        _lastLightVer = lv;
        _lastCasterVerSum = casterVerSum;
        _lastCasterCount = casters.length;

        syncCasterMatrices(eng, casters);

        // Pass 1: Shadow depth
        const dp = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: esmTexture.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
            depthStencilAttachment: {
                view: depthBuf.createView(),
                depthLoadOp: "clear",
                depthStoreOp: "store",
                depthClearValue: 1.0,
            },
        });
        dp.setPipeline(depthPipeline);
        dp.setBindGroup(0, depthSceneBG);
        drawCasters(dp, casters);
        dp.end();

        // Pass 2: Blur H
        const bh = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: blurTexH.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        });
        bh.setPipeline(blurPipeline);
        bh.setBindGroup(0, blurHBG);
        bh.draw(3);
        bh.end();

        // Pass 3: Blur V
        const bv = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: blurTexV.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        });
        bv.setPipeline(blurPipeline);
        bv.setBindGroup(0, blurVBG);
        bv.draw(3);
        bv.end();

        return casters.length + 2; // depth draws + 2 blur passes
    };

    return sg;
}
