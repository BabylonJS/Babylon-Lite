/**
 * Skybox CubeMap Material — renders a cube map on the inside of a box.
 * Material owns shaders (pillar 4c). Self-contained pipeline and bind groups.
 *
 * Used for StandardMaterial + CubeTexture(SKYBOX_MODE) in Babylon.
 * Renders backfaces (no culling → sees inside of box).
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../render/renderable.js";
import skyVertSrc from "../../../shaders/skybox-cubemap.vertex.wgsl?raw";
import skyFragSrc from "../../../shaders/skybox-cubemap.fragment.wgsl?raw";
import { getSceneBindGroupLayout, createStandardPipelineDescriptor } from "../../render/scene-helpers.js";
import { WGSL_FOG, getWgslSceneUniformsUnified } from "../../shader/wgsl-helpers.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";

export interface SkyboxCubeMapResources {
    meshBindGroup: GPUBindGroup;
    meshUBO: GPUBuffer;
    /** Bind group layouts + shader modules needed to (re)build a pipeline per target. */
    _meshBGL: GPUBindGroupLayout;
    _vertModule: GPUShaderModule;
    _fragModule: GPUShaderModule;
    /** Target-keyed pipeline cache — pipelines depend on color format/sample count. */
    _pipelines: Map<string, GPURenderPipeline>;
}

/** Legacy alias — kept for callers that only need the 3 "hot" fields. */
export type SkyboxCubeMapGPU = SkyboxCubeMapResources;

/**
 * Build target-independent GPU resources for rendering a cube-mapped skybox.
 * Pipelines are built lazily per-target via `getSkyboxCubeMapPipeline`.
 * Group(0) (scene UBO) is bound by the render pass.
 */
export function buildSkyboxCubeMapGPU(engine: EngineContextInternal, worldMatrix: Float32Array, cubeView: GPUTextureView, cubeSampler: GPUSampler): SkyboxCubeMapResources {
    const device = engine.device;

    const meshBindGroupLayout = device.createBindGroupLayout({
        label: "skybox-cm-mesh",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
    });

    const vertModule = device.createShaderModule({ code: getWgslSceneUniformsUnified() + skyVertSrc, label: "skybox-cm-vert" });
    const fragModule = device.createShaderModule({ code: getWgslSceneUniformsUnified() + WGSL_FOG + skyFragSrc, label: "skybox-cm-frag" });

    const meshUBO = createUniformBuffer(engine, worldMatrix as Float32Array);

    const meshBindGroup = device.createBindGroup({
        layout: meshBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: meshUBO } },
            { binding: 1, resource: cubeView },
            { binding: 2, resource: cubeSampler },
        ],
    });

    return {
        meshBindGroup,
        meshUBO,
        _meshBGL: meshBindGroupLayout,
        _vertModule: vertModule,
        _fragModule: fragModule,
        _pipelines: new Map(),
    };
}

/** Get or create the skybox cubemap pipeline for a specific render target signature. */
export function getSkyboxCubeMapPipeline(engine: EngineContextInternal, res: SkyboxCubeMapResources, target: RenderTargetSignature): GPURenderPipeline {
    const key = `${target.colorFormat}|${target.sampleCount}|${target.depthStencilFormat ?? ""}`;
    let pipeline = res._pipelines.get(key);
    if (pipeline) {
        return pipeline;
    }
    pipeline = engine.device.createRenderPipeline(
        createStandardPipelineDescriptor({
            label: `skybox-cubemap-pipeline:${key}`,
            engine,
            bgls: [getSceneBindGroupLayout(engine), res._meshBGL],
            vertModule: res._vertModule,
            fragModule: res._fragModule,
            vertexBuffers: [
                { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as GPUVertexFormat }] },
            ],
            format: target.colorFormat,
            msaaSamples: target.sampleCount,
            cullMode: "none",
        })
    );
    res._pipelines.set(key, pipeline);
    return pipeline;
}
