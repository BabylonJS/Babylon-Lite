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
import type { Renderable } from "../../render/renderable.js";

import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxFragSrc from "../../../shaders/skybox.fragment.wgsl?raw";
import { createStandardPipelineDescriptor } from "../../render/scene-helpers.js";
import { WGSL_SCENE_UNIFORMS_PBR, WGSL_DITHER } from "../../shader/wgsl-helpers.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";
import { createSingleUniformBGL } from "../../shader/bgl-helpers.js";

const SKY_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad

function createSkyboxBuffers(engine: EngineContextInternal, S: number): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number } {
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

function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4 {
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

interface SkyboxMaterial {
    getPipeline(engine: EngineContextInternal, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
    createBindGroup(engine: EngineContextInternal, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}

function createSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout): SkyboxMaterial {
    let pipeline: GPURenderPipeline | null = null;
    let layout: GPUBindGroupLayout | null = null;
    let _cachedDevice: GPUDevice | null = null;

    function getLayout(engine: EngineContextInternal): GPUBindGroupLayout {
        const device = engine.device;
        if (layout && _cachedDevice === device) {
            return layout;
        }
        layout = createSingleUniformBGL(engine, "skybox-material", GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
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

export function buildSolidSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    skyHalfSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number]
): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);
    const cc = scene.clearColor;
    const skyBufs = createSkyboxBuffers(engine, skyHalfSize);

    const skyMat = createSkyboxMaterial(sceneBindGroupLayout);
    const skyOutputColor: [number, number, number] = [cc.r, cc.g, cc.b];
    const skyUBO = createSkyMeshUBO(engine, skyboxWorld, primaryColor, skyOutputColor);
    const skyPipeline = skyMat.getPipeline(engine, engine.format, engine.msaaSamples);
    const skyBG = skyMat.createBindGroup(engine, skyUBO, envTextures);

    return {
        order: 0, // skybox renders first (behind everything)
        isTransparent: false,
        draw(pass) {
            pass.setBindGroup(0, sceneBindGroup);
            pass.setPipeline(skyPipeline);
            pass.setBindGroup(1, skyBG);
            pass.setVertexBuffer(0, skyBufs.posBuffer);
            pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
            pass.drawIndexed(skyBufs.idxCount);
            return 1;
        },
    };
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
