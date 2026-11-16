/** Shared cubemap skybox material factory, cube geometry and Renderable shell — used by DDS and HDR skyboxes.
 *  BGL: binding 0 = uniform buffer, binding 1 = cube texture, binding 2 = sampler. */

import { F32, U16 } from "../../engine/typed-arrays.js";
import { BU, SS } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { Renderable } from "../../render/renderable.js";
import type { EnvironmentSkyboxKind, SceneContext } from "../../scene/scene-core.js";
import { createDefaultPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { targetSignatureKey } from "../../engine/render-target-signature.js";
import { createMappedBuffer } from "../../resource/mapped-buffer.js";
import { _rightHanded } from "#coordinate-system";

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

export interface CubemapSkyboxMaterial {
    getPipeline(engine: EngineContext, sig: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContext, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}

/** Create the unit-cube vertex and index buffers shared by the DDS and HDR skyboxes. */
export function createSkyboxBuffers(engine: EngineContext, S: number): [positionBuffer: GPUBuffer, indexBuffer: GPUBuffer] {
    // prettier-ignore
    const positions = new F32([
    -S,-S,-S,  S,-S,-S, -S, S,-S,  S, S,-S,
    -S,-S, S,  S,-S, S, -S, S, S,  S, S, S,
  ]);
    // prettier-ignore
    const indices = new U16([
    6,4,5, 7,6,5,  0,2,3, 1,0,3,
    5,1,3, 7,5,3,  0,4,6, 2,0,6,
    3,2,6, 7,3,6,  0,1,5, 4,0,5,
  ]);
    return [createMappedBuffer(engine, positions, BU.VERTEX), createMappedBuffer(engine, indices, BU.INDEX)];
}

/** Apply the scene's environment skybox shader patches to a fragment, or return it unchanged.
 *  Taking the fragment as a parameter keeps each raw WGSL import referenced once per caller,
 *  so minifiers cannot inline the shader string twice. */
export async function composeSkyboxFragment(scene: SceneContext, fragment: string, kind: EnvironmentSkyboxKind): Promise<string> {
    if (_rightHanded !== null) {
        // Right-handed: negate the cube lookup's Z after every environment patch (rotation, blur), like
        // Babylon.js's REFLECTIONMAP_OPPOSITEZ and the PBR `rotateY`. The shader is minified, so the
        // lookup is found by shape: the direction is the third `textureSampleLevel` argument.
        return ((await scene._environmentSkyboxShaderComposer?.(fragment, kind)) ?? fragment).replace(/(textureSampleLevel\([^,]+,[^,]+,)([^,]+)/, "$1($2)*vec3f(1.,1.,-1.)");
    }
    return (await scene._environmentSkyboxShaderComposer?.(fragment, kind)) ?? fragment;
}

/** Wrap a cubemap skybox material, bind group and cube buffers as an opaque order-0 Renderable. */
export function createCubemapSkyboxRenderable(mat: CubemapSkyboxMaterial, bindGroup: GPUBindGroup, positionBuffer: GPUBuffer, indexBuffer: GPUBuffer): Renderable {
    const r: Renderable = {
        order: 0,
        isTransparent: false,
        bind(eng, sig) {
            return {
                renderable: r,
                pipeline: mat.getPipeline(eng as EngineContext, sig),
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, positionBuffer);
                    pass.setIndexBuffer(indexBuffer, "uint16");
                    pass.drawIndexed(36);
                    return 1;
                },
            };
        },
    };
    return r;
}

/** Module-global pipeline + layout caches shared across all cubemap-skybox instances.
 *  Pipeline keys include final fragment code so composed variants don't collide. */
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
            const key = `${fragCode}|${targetSignatureKey(sig)}`;
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
