import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";

import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxFragSrc from "../../../shaders/skybox.fragment.wgsl?raw";
import { createStandardPipelineDescriptor } from "../../render/scene-helpers.js";
import { WGSL_SCENE_UNIFORMS_PBR, WGSL_DITHER } from "../../shader/wgsl-helpers.js";

// ─── Skybox Material (solid clearColor output) ──────────────────────────────

export interface SkyboxMaterial {
    getPipeline(engine: EngineContextInternal, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}

export function createSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout): SkyboxMaterial {
    let pipeline: GPURenderPipeline | null = null;
    let layout: GPUBindGroupLayout | null = null;
    let _cachedDevice: GPUDevice | null = null;

    function getLayout(engine: EngineContextInternal): GPUBindGroupLayout {
        const device = engine.device;
        if (layout && _cachedDevice === device) {
            return layout;
        }
        layout = device.createBindGroupLayout({
            label: "skybox-material",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
        });
        return layout;
    }

    return {
        getPipeline(engine, format, msaaSamples) {
            const device = engine.device;
            if (pipeline && _cachedDevice === device) {
                return pipeline;
            }
            pipeline = null;
            layout = null;
            _cachedDevice = device;
            const vertModule = device.createShaderModule({ code: WGSL_SCENE_UNIFORMS_PBR + skyboxVertSrc, label: "skybox-vert" });
            const fragModule = device.createShaderModule({ code: WGSL_DITHER + skyboxFragSrc, label: "skybox-frag" });
            const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

            pipeline = device.createRenderPipeline(
                createStandardPipelineDescriptor({
                    label: "skybox-pipeline",
                    engine,
                    bgls: [sceneBindGroupLayout, getLayout(engine)],
                    vertModule,
                    fragModule,
                    vertexBuffers: SKYBOX_POS_BUFFER,
                    format,
                    msaaSamples,
                    depthWriteEnabled: false,
                })
            );
            return pipeline;
        },

        createBindGroup(engine, meshUBO, _env) {
            const device = engine.device;
            return device.createBindGroup({
                layout: getLayout(engine),
                entries: [{ binding: 0, resource: { buffer: meshUBO } }],
            });
        },
    };
}

// ─── Skybox Mesh Data ───────────────────────────────────────────────────────

/** Skybox box geometry (24 verts, 36 indices — matches Babylon). */
export function createSkyboxBuffers(engine: EngineContextInternal, S = 15): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number } {
    // prettier-ignore
    const positions = new Float32Array([
     S,-S, S, -S,-S, S, -S, S, S,  S, S, S,
     S, S,-S, -S, S,-S, -S,-S,-S,  S,-S,-S,
     S, S,-S,  S,-S,-S,  S,-S, S,  S, S, S,
    -S, S, S, -S,-S, S, -S,-S,-S, -S, S,-S,
    -S, S, S, -S, S,-S,  S, S,-S,  S, S, S,
     S,-S, S,  S,-S,-S, -S,-S,-S, -S,-S, S,
  ]);
    // prettier-ignore
    const indices = new Uint16Array([
     2, 1, 0,  3, 2, 0,   6, 5, 4,  7, 6, 4,
    10, 9, 8, 11,10, 8,  14,13,12, 15,14,12,
    18,17,16, 19,18,16,  22,21,20, 23,22,20,
  ]);

    return {
        posBuffer: createBuf(engine, positions, GPUBufferUsage.VERTEX),
        idxBuffer: createBuf(engine, indices, GPUBufferUsage.INDEX),
        idxCount: 36,
    };
}

export function createBuf(engine: EngineContextInternal, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({
        size: Math.max(data.byteLength, 4),
        usage: usage | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
}

// ─── Shared Cubemap Skybox Material ──────────────────────────────────────────
// Reusable material factory for any cubemap-based skybox (DDS, HDR).
// BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler.

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

export interface CubemapSkyboxMaterial {
    getPipeline(engine: EngineContextInternal, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}

export function createCubemapSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout, label: string, vertCode: string, fragCode: string): CubemapSkyboxMaterial {
    let pipeline: GPURenderPipeline | null = null;
    let layout: GPUBindGroupLayout | null = null;
    let _cachedDevice: GPUDevice | null = null;

    function getLayout(engine: EngineContextInternal): GPUBindGroupLayout {
        const device = engine.device;
        if (layout && _cachedDevice === device) {
            return layout;
        }
        layout = device.createBindGroupLayout({
            label: `${label}-material`,
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        return layout;
    }

    return {
        getPipeline(engine, format, msaaSamples) {
            const device = engine.device;
            if (pipeline && _cachedDevice === device) {
                return pipeline;
            }
            pipeline = null;
            layout = null;
            _cachedDevice = device;
            const vertModule = device.createShaderModule({ code: vertCode, label: `${label}-vert` });
            const fragModule = device.createShaderModule({ code: fragCode, label: `${label}-frag` });

            pipeline = device.createRenderPipeline(
                createStandardPipelineDescriptor({
                    label: `${label}-pipeline`,
                    engine,
                    bgls: [sceneBindGroupLayout, getLayout(engine)],
                    vertModule,
                    fragModule,
                    vertexBuffers: SKYBOX_POS_BUFFER,
                    format,
                    msaaSamples,
                    depthWriteEnabled: false,
                })
            );
            return pipeline;
        },

        createBindGroup(engine, meshUBO, cubeView, cubeSampler) {
            const device = engine.device;
            return device.createBindGroup({
                layout: getLayout(engine),
                entries: [
                    { binding: 0, resource: { buffer: meshUBO } },
                    { binding: 1, resource: cubeView },
                    { binding: 2, resource: cubeSampler },
                ],
            });
        },
    };
}

// ─── Shared Skybox World Matrix ──────────────────────────────────────────────

/** Build an identity world matrix translated to rootPosition (no scaling). */
export function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4 {
    const world = new Float32Array(16) as Mat4;
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;
    world[12] = rootPosition[0];
    world[13] = rootPosition[1];
    world[14] = rootPosition[2];
    return world;
}
