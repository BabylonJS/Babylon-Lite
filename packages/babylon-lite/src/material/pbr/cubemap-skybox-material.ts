/** Shared cubemap skybox material factory — used by DDS and HDR skyboxes.
 *  BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../render/renderable.js";
import { createStandardPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];
export interface CubemapSkyboxMaterial {
    /** Get or create a pipeline for the given render-target signature. */
    getPipeline(engine: EngineContextInternal, target: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}

export function createCubemapSkyboxMaterial(label: string, vertCode: string, fragCode: string): CubemapSkyboxMaterial {
    // Target-keyed pipeline cache — pipelines depend on colorFormat/sampleCount/depthFormat.
    const pipelines = new Map<string, GPURenderPipeline>();
    let layout: GPUBindGroupLayout | null = null;
    let _cachedDevice: GPUDevice | null = null;
    let _vertModule: GPUShaderModule | null = null;
    let _fragModule: GPUShaderModule | null = null;

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

    function ensureModules(engine: EngineContextInternal): void {
        const device = engine.device;
        if (_cachedDevice !== device) {
            // Device changed — drop all target-specific pipelines + shader modules.
            pipelines.clear();
            layout = null;
            _vertModule = null;
            _fragModule = null;
            _cachedDevice = device;
        }
        if (!_vertModule) {
            _vertModule = device.createShaderModule({ code: vertCode, label: `${label}-vert` });
        }
        if (!_fragModule) {
            _fragModule = device.createShaderModule({ code: fragCode, label: `${label}-frag` });
        }
    }

    return {
        getPipeline(engine, target) {
            ensureModules(engine);
            const key = `${target.colorFormat}|${target.sampleCount}|${target.depthStencilFormat ?? ""}`;
            let pipeline = pipelines.get(key);
            if (pipeline) {
                return pipeline;
            }
            pipeline = engine.device.createRenderPipeline(
                createStandardPipelineDescriptor({
                    label: `${label}-pipeline:${key}`,
                    engine,
                    bgls: [getSceneBindGroupLayout(engine), getLayout(engine)],
                    vertModule: _vertModule!,
                    fragModule: _fragModule!,
                    vertexBuffers: SKYBOX_POS_BUFFER,
                    format: target.colorFormat,
                    msaaSamples: target.sampleCount,
                    depthWriteEnabled: false,
                })
            );
            pipelines.set(key, pipeline);
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
