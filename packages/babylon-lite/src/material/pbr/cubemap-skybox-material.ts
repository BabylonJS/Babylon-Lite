/** Shared cubemap skybox material factory — used by DDS and HDR skyboxes.
 *  BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { createDefaultPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { targetSignatureKey } from "../../engine/render-target.js";

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

export interface CubemapSkyboxMaterial {
    getPipeline(engine: EngineContextInternal, sig: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}

/** Module-global pipeline + layout caches shared across all cubemap-skybox instances.
 *  Keyed by `${label}|${sigKey}` so HDR and DDS variants don't collide. */
const _cmPipelines = new Map<string, GPURenderPipeline>();
const _cmLayouts = new Map<string, GPUBindGroupLayout>();
let _cmCachedDevice: GPUDevice | null = null;

export function createCubemapSkyboxMaterial(label: string, vertCode: string, fragCode: string): CubemapSkyboxMaterial {
    function getLayout(engine: EngineContextInternal): GPUBindGroupLayout {
        const device = engine.device;
        if (_cmCachedDevice !== device) {
            _cmPipelines.clear();
            _cmLayouts.clear();
            _cmCachedDevice = device;
        }
        const cached = _cmLayouts.get(label);
        if (cached) {
            return cached;
        }
        const layout = device.createBindGroupLayout({
            label: `${label}-material`,
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        _cmLayouts.set(label, layout);
        return layout;
    }

    return {
        getPipeline(engine, sig) {
            const device = engine.device;
            if (_cmCachedDevice !== device) {
                _cmPipelines.clear();
                _cmLayouts.clear();
                _cmCachedDevice = device;
            }
            const key = `${label}|${targetSignatureKey(sig)}`;
            const cached = _cmPipelines.get(key);
            if (cached) {
                return cached;
            }
            const vertModule = device.createShaderModule({ code: vertCode, label: `${label}-vert` });
            const fragModule = device.createShaderModule({ code: fragCode, label: `${label}-frag` });

            const pipeline = device.createRenderPipeline(
                createDefaultPipelineDescriptor({
                    label: `${label}-pipeline`,
                    engine,
                    bgls: [getSceneBindGroupLayout(engine), getLayout(engine)],
                    vertModule,
                    fragModule,
                    vertexBuffers: SKYBOX_POS_BUFFER,
                    format: sig.colorFormat,
                    depthStencilFormat: sig.depthStencilFormat,
                    msaaSamples: sig.sampleCount,
                    depthWriteEnabled: false,
                    flipY: sig.flipY,
                })
            );
            _cmPipelines.set(key, pipeline);
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
