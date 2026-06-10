/** Shared cubemap skybox material factory — used by DDS and HDR skyboxes.
 *  BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler. */

import { SS } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { createDefaultPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { targetSignatureKey } from "../../engine/render-target.js";

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

export interface CubemapSkyboxMaterial {
    getPipeline(engine: EngineContext, sig: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContext, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}

/** Module-global pipeline + layout caches shared across all cubemap-skybox instances.
 *  Keyed by `${label}|${sigKey}` so HDR and DDS variants don't collide. */
const _cmPipelines = new Map<string, GPURenderPipeline>();
const _cmLayouts = new Map<string, GPUBindGroupLayout>();
let _cmCachedDevice: GPUDevice | null = null;

export function createCubemapSkyboxMaterial(label: string, vertCode: string, fragCode: string): CubemapSkyboxMaterial {
    function getLayout(engine: EngineContext): GPUBindGroupLayout {
        const device = engine._device;
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
                { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
                { binding: 2, visibility: SS.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        _cmLayouts.set(label, layout);
        return layout;
    }

    return {
        getPipeline(_engine, sig) {
            const device = _engine._device;
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
            const _vertModule = device.createShaderModule({ code: vertCode, label: `${label}-vert` });
            const _fragModule = device.createShaderModule({ code: fragCode, label: `${label}-frag` });

            const pipeline = device.createRenderPipeline(
                createDefaultPipelineDescriptor({
                    _label: `${label}-pipeline`,
                    _engine,
                    _bgls: [getSceneBindGroupLayout(_engine), getLayout(_engine)],
                    _vertModule,
                    _fragModule,
                    _vertexBuffers: SKYBOX_POS_BUFFER,
                    _format: sig._colorFormat!,
                    _depthStencilFormat: sig._depthStencilFormat,
                    _depthCompare: sig._depthCompare,
                    _msaaSamples: sig._sampleCount,
                    _depthWriteEnabled: false,
                })
            );
            _cmPipelines.set(key, pipeline);
            return pipeline;
        },

        createBindGroup(engine, meshUBO, cubeView, cubeSampler) {
            const device = engine._device;
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
