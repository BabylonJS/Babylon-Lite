/** Solid-color skybox renderable — the clear-color background used by PBR
 *  environment scenes when no HDR/DDS skybox is provided.
 *
 *  Dynamically imported from `background-renderable.ts` so scenes that pass
 *  `skipSkybox: true` (or use a dyn-imported HDR/DDS skybox instead) don't
 *  pay for the shader module or cube geometry. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable, RenderTargetSignature } from "../../render/renderable.js";

import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxFragSrc from "../../../shaders/skybox.fragment.wgsl?raw";
import { createStandardPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { WGSL_DITHER, getWgslSceneUniformsUnified } from "../../shader/wgsl-helpers.js";
import { createSkyboxBuffers, buildSkyboxWorldMatrix } from "./skybox-geometry.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { createSingleUniformBGL } from "../../shader/bgl-helpers.js";

const SKY_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad

interface SkyboxMaterial {
    getPipeline(engine: EngineContextInternal, target: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}

function createSkyboxMaterial(): SkyboxMaterial {
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
        layout = createSingleUniformBGL(engine, "skybox-material", GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
        return layout;
    }

    function ensureModules(engine: EngineContextInternal): void {
        const device = engine.device;
        if (_cachedDevice !== device) {
            pipelines.clear();
            layout = null;
            _vertModule = null;
            _fragModule = null;
            _cachedDevice = device;
        }
        if (!_vertModule) {
            _vertModule = device.createShaderModule({ code: getWgslSceneUniformsUnified() + skyboxVertSrc, label: "skybox-vert" });
        }
        if (!_fragModule) {
            _fragModule = device.createShaderModule({ code: WGSL_DITHER + skyboxFragSrc, label: "skybox-frag" });
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
            const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];
            pipeline = engine.device.createRenderPipeline(
                createStandardPipelineDescriptor({
                    label: `skybox-pipeline:${key}`,
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

        createBindGroup(engine, meshUBO, _env) {
            const device = engine.device;
            return device.createBindGroup({
                layout: getLayout(engine),
                entries: [{ binding: 0, resource: { buffer: meshUBO } }],
            });
        },
    };
}

export function buildSolidSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    skyHalfSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number]
): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);
    const cc = scene.clearColor;
    const skyBufs = createSkyboxBuffers(engine, skyHalfSize);

    const skyMat = createSkyboxMaterial();
    const skyOutputColor: [number, number, number] = [cc.r, cc.g, cc.b];
    const skyUBO = createSkyMeshUBO(engine, skyboxWorld, primaryColor, skyOutputColor);
    const skyBG = skyMat.createBindGroup(engine, skyUBO, envTextures);

    const r: Renderable = {
        order: 0, // skybox renders first (behind everything)
        isTransparent: false,
        bind(eng, target) {
            const skyPipeline = skyMat.getPipeline(eng as EngineContextInternal, target);
            return {
                renderable: r,
                pipeline: skyPipeline,
                draw(pass) {
                    pass.setBindGroup(1, skyBG);
                    pass.setVertexBuffer(0, skyBufs.posBuffer);
                    pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
                    pass.drawIndexed(skyBufs.idxCount);
                    return 1;
                },
            };
        },
    };
    return r;
}

function createSkyMeshUBO(engine: EngineContextInternal, world: Mat4, primaryColor: [number, number, number], skyOutputColor: [number, number, number]): GPUBuffer {
    const data = new Float32Array(SKY_MESH_UNIFORM_SIZE / 4);
    data.set(world, 0);
    data[16] = primaryColor[0];
    data[17] = primaryColor[1];
    data[18] = primaryColor[2];
    data[20] = skyOutputColor[0];
    data[21] = skyOutputColor[1];
    data[22] = skyOutputColor[2];
    return createUniformBuffer(engine, data);
}
