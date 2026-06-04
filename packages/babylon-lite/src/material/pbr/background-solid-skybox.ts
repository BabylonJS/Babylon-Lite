/** Solid-color skybox renderable — the clear-color background used by PBR
 *  environment scenes when no HDR/DDS skybox is provided.
 *
 *  Dynamically imported from `background-renderable.ts` so scenes that pass
 *  `skipSkybox: true` (or use a dyn-imported HDR/DDS skybox instead) don't
 *  pay for the shader module or cube geometry. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable } from "../../render/renderable.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";

import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxFragSrc from "../../../shaders/skybox.fragment.wgsl?raw";
import { createDefaultPipelineDescriptor, getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { WGSL_DITHER } from "../../shader/wgsl-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";
import { createSingleUniformBGL } from "../../shader/bgl-helpers.js";

const SKY_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad

function createSkyboxBuffers(engine: EngineContext, S: number): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number } {
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
        posBuffer: createMappedBuffer(engine, positions, GPUBufferUsage.VERTEX),
        idxBuffer: createMappedBuffer(engine, indices, GPUBufferUsage.INDEX),
        idxCount: 36,
    };
}

function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Float32Array {
    const world = new Float32Array(16);
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;
    world[12] = rootPosition[0];
    world[13] = rootPosition[1];
    world[14] = rootPosition[2];
    return world;
}

interface SkyboxMaterial {
    getPipeline(engine: EngineContext, sig: RenderTargetSignature): GPURenderPipeline;
    createBindGroup(engine: EngineContext, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}

const SKYBOX_POS_BUFFER: GPUVertexBufferLayout[] = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }] }];

/** Module-global pipeline cache shared by all solid-skybox renderables. */
const _skyPipelines = new Map<string, GPURenderPipeline>();
let _skyLayout: GPUBindGroupLayout | null = null;
let _skyCachedDevice: GPUDevice | null = null;

function createSkyboxMaterial(): SkyboxMaterial {
    function getLayout(engine: EngineContext): GPUBindGroupLayout {
        const device = engine._device;
        if (_skyLayout && _skyCachedDevice === device) {
            return _skyLayout;
        }
        _skyLayout = createSingleUniformBGL(engine, "skybox-material", GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
        return _skyLayout;
    }

    return {
        getPipeline(_engine, sig) {
            const device = _engine._device;
            if (_skyCachedDevice !== device) {
                _skyPipelines.clear();
                _skyLayout = null;
                _skyCachedDevice = device;
            }
            const key = targetSignatureKey(sig);
            const cached = _skyPipelines.get(key);
            if (cached) {
                return cached;
            }
            const _vertModule = device.createShaderModule({ code: SCENE_UBO_WGSL + skyboxVertSrc, label: "skybox-vert" });
            const _fragModule = device.createShaderModule({ code: WGSL_DITHER + skyboxFragSrc, label: "skybox-frag" });

            const pipeline = device.createRenderPipeline(
                createDefaultPipelineDescriptor({
                    _label: "skybox-pipeline",
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
                    _flipY: sig._flipY,
                })
            );
            _skyPipelines.set(key, pipeline);
            return pipeline;
        },

        createBindGroup(engine, meshUBO, _env) {
            const device = engine._device;
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
    const engine = scene.engine;
    const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);
    const cc = scene.clearColor;
    const skyBufs = createSkyboxBuffers(engine, skyHalfSize);

    const skyMat = createSkyboxMaterial();
    const skyOutputColor: [number, number, number] = [cc.r, cc.g, cc.b];
    const skyUBO = createSkyMeshUBO(engine, skyboxWorld as unknown as Mat4, primaryColor, skyOutputColor);
    const skyBG = skyMat.createBindGroup(engine, skyUBO, envTextures);

    const r: Renderable = {
        order: 0, // skybox renders first (behind everything)
        isTransparent: false,
        bind(eng, sig) {
            return {
                renderable: r,
                pipeline: skyMat.getPipeline(eng as EngineContext, sig),
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

function createSkyMeshUBO(engine: EngineContext, world: Mat4, primaryColor: [number, number, number], skyOutputColor: [number, number, number]): GPUBuffer {
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
