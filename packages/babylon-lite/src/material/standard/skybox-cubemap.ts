/**
 * Skybox CubeMap Material — renders a cube map on the inside of a box.
 * Material owns shaders (pillar 4c). Self-contained pipeline and bind groups.
 *
 * Used for StandardMaterial + CubeTexture(SKYBOX_MODE) in Babylon.
 * Renders backfaces (no culling → sees inside of box).
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import skyVertSrc from "../../../shaders/skybox-cubemap.vertex.wgsl?raw";
import skyFragSrc from "../../../shaders/skybox-cubemap.fragment.wgsl?raw";
import { getSceneBindGroupLayout, createDefaultPipelineDescriptor } from "../../render/scene-helpers.js";
import { WGSL_FOG } from "../../shader/wgsl-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { targetSignatureKey } from "../../engine/render-target.js";

export interface SkyboxCubeMapGPU {
    /** Sig-keyed pipeline lookup (called from `bind()` once the target sig is known). */
    getPipeline(engine: EngineContextInternal, sig: RenderTargetSignature): GPURenderPipeline;
    meshBindGroup: GPUBindGroup;
    meshUBO: GPUBuffer;
    meshBindGroupLayout: GPUBindGroupLayout;
    /** Pre-compiled shader modules — sig-independent. */
    vertModule: GPUShaderModule;
    fragModule: GPUShaderModule;
    /** Per-sig pipeline cache, owned by this skybox instance. */
    pipelines: Map<string, GPURenderPipeline>;
}

/**
 * Build the per-skybox GPU resources (mesh BGL + bind group + UBO + shader modules
 * + pipeline cache). The pipeline is created lazily by `getPipeline(engine, sig)`
 * once the target sig is known. The scene bind group is supplied per-pass by the
 * active RenderPassTask.
 */
export function buildSkyboxCubeMapGPU(engine: EngineContextInternal, worldMatrix: Float32Array, cubeView: GPUTextureView, cubeSampler: GPUSampler): SkyboxCubeMapGPU {
    const device = engine.device;
    const meshBindGroupLayout = device.createBindGroupLayout({
        label: "skybox-cm-mesh",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
    });

    const meshUBO = createUniformBuffer(engine, worldMatrix);
    const meshBindGroup = device.createBindGroup({
        layout: meshBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: meshUBO } },
            { binding: 1, resource: cubeView },
            { binding: 2, resource: cubeSampler },
        ],
    });

    const vertModule = device.createShaderModule({ code: SCENE_UBO_WGSL + skyVertSrc, label: "skybox-cm-vert" });
    const fragModule = device.createShaderModule({ code: SCENE_UBO_WGSL + WGSL_FOG + skyFragSrc, label: "skybox-cm-frag" });

    const gpu: SkyboxCubeMapGPU = {
        getPipeline(eng, sig) {
            const key = targetSignatureKey(sig);
            const cached = gpu.pipelines.get(key);
            if (cached) {
                return cached;
            }
            const pipeline = eng.device.createRenderPipeline(
                createDefaultPipelineDescriptor({
                    label: "skybox-cubemap-pipeline",
                    engine: eng,
                    bgls: [getSceneBindGroupLayout(eng), gpu.meshBindGroupLayout],
                    vertModule: gpu.vertModule,
                    fragModule: gpu.fragModule,
                    vertexBuffers: [
                        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                    ],
                    format: sig.colorFormat,
                    depthStencilFormat: sig.depthStencilFormat,
                    msaaSamples: sig.sampleCount,
                    cullMode: "none",
                    flipY: sig.flipY,
                })
            );
            gpu.pipelines.set(key, pipeline);
            return pipeline;
        },
        meshBindGroup,
        meshUBO,
        meshBindGroupLayout,
        vertModule,
        fragModule,
        pipelines: new Map(),
    };
    return gpu;
}
