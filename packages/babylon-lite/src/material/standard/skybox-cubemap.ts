/**
 * Skybox CubeMap Material — renders a cube map on the inside of a box.
 * Material owns shaders (pillar 4c). Self-contained pipeline and bind groups.
 *
 * Used for StandardMaterial + CubeTexture(SKYBOX_MODE) in Babylon.
 * Renders backfaces (no culling → sees inside of box).
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import skyVertSrc from "../../../shaders/skybox-cubemap.vertex.wgsl?raw";
import skyFragSrc from "../../../shaders/skybox-cubemap.fragment.wgsl?raw";
import { getSceneBindGroupLayout, createStandardPipelineDescriptor } from "../../render/scene-helpers.js";
import { WGSL_SCENE_UNIFORMS_STD, WGSL_FOG } from "../../shader/wgsl-helpers.js";

const MESH_UBO_SIZE = 64;

export interface SkyboxCubeMapGPU {
    pipeline: GPURenderPipeline;
    sceneBindGroup: GPUBindGroup;
    meshBindGroup: GPUBindGroup;
    sceneUBO: GPUBuffer;
    meshUBO: GPUBuffer;
}

/**
 * Build GPU pipeline for rendering a cube-mapped skybox.
 * Shares the scene UBO from StandardMaterial (same layout).
 */
export function buildSkyboxCubeMapGPU(
    engine: EngineContextInternal,
    format: GPUTextureFormat,
    msaaSamples: number,
    sceneUBO: GPUBuffer,
    worldMatrix: Float32Array,
    cubeView: GPUTextureView,
    cubeSampler: GPUSampler
): SkyboxCubeMapGPU {
    const device = engine.device;
    const sceneBindGroupLayout = getSceneBindGroupLayout(engine);

    const meshBindGroupLayout = device.createBindGroupLayout({
        label: "skybox-cm-mesh",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
    });

    const vertModule = device.createShaderModule({ code: WGSL_SCENE_UNIFORMS_STD + skyVertSrc, label: "skybox-cm-vert" });
    const fragModule = device.createShaderModule({ code: WGSL_SCENE_UNIFORMS_STD + WGSL_FOG + skyFragSrc, label: "skybox-cm-frag" });

    const pipeline = device.createRenderPipeline(
        createStandardPipelineDescriptor({
            label: "skybox-cubemap-pipeline",
            engine,
            bgls: [sceneBindGroupLayout, meshBindGroupLayout],
            vertModule,
            fragModule,
            vertexBuffers: [
                { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] },
                { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as GPUVertexFormat }] },
            ],
            format,
            msaaSamples,
            cullMode: "none",
        })
    );

    const meshUBO = device.createBuffer({
        size: MESH_UBO_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(meshUBO, 0, worldMatrix as Float32Array<ArrayBuffer>);

    const sceneBindGroup = device.createBindGroup({
        layout: sceneBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });

    const meshBindGroup = device.createBindGroup({
        layout: meshBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: meshUBO } },
            { binding: 1, resource: cubeView },
            { binding: 2, resource: cubeSampler },
        ],
    });

    return { pipeline, sceneBindGroup, meshBindGroup, sceneUBO, meshUBO };
}
