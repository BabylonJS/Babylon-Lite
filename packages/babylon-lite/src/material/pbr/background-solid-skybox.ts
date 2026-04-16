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
import { createSkyboxBuffers, buildSkyboxWorldMatrix } from "./skybox-geometry.js";

const SKY_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad

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
    const device = engine.device;
    const data = new Float32Array(SKY_MESH_UNIFORM_SIZE / 4);
    data.set(world, 0);
    data[16] = primaryColor[0];
    data[17] = primaryColor[1];
    data[18] = primaryColor[2];
    data[20] = skyOutputColor[0];
    data[21] = skyOutputColor[1];
    data[22] = skyOutputColor[2];
    const buf = device.createBuffer({
        size: SKY_MESH_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data);
    return buf;
}
