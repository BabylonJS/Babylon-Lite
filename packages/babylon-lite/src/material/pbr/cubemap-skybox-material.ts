/** Shared cubemap skybox material factory — used by DDS and HDR skyboxes.
 *  BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler. */

import type { EngineContextInternal } from "../../engine/engine.js";
import { createStandardPipelineDescriptor } from "../../render/scene-helpers.js";

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
