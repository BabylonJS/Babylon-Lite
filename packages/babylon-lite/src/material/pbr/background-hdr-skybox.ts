/** HDR cubemap skybox — lazy-loaded only when useCubemapSkybox is true.
 *  Contains the HDR skybox material, shader, UBO, and skybox geometry.
 *  Self-contained: computes scene bounds and builds a full Renderable.
 *  Tree-shaken away from scenes that use the default solid-color skybox. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable } from "../../render/renderable.js";
import { createCubemapSkyboxMaterial } from "./cubemap-skybox-material.js";
import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxHdrFragSrc from "../../../shaders/skybox-hdr.fragment.wgsl?raw";
import { WGSL_SCENE_UNIFORMS_PBR } from "../../shader/wgsl-helpers.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";

const SKY_HDR_UNIFORM_SIZE = 112; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad + exposure + contrast + pad2

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

/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export function buildHdrSkyboxRenderable(
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
    const mat = createCubemapSkyboxMaterial(sceneBindGroupLayout, "skybox-hdr", WGSL_SCENE_UNIFORMS_PBR + skyboxVertSrc, skyboxHdrFragSrc);
    const ubo = createSkyHdrMeshUBO(engine, skyboxWorld, primaryColor, [cc.r, cc.g, cc.b], scene.imageProcessing.exposure, scene.imageProcessing.contrast);

    const pipeline = mat.getPipeline(engine, engine.format, engine.msaaSamples);
    const bindGroup = mat.createBindGroup(engine, ubo, envTextures.specularCubeView!, envTextures.cubeSampler);

    return {
        order: 0,
        isTransparent: false,
        draw(pass) {
            pass.setBindGroup(0, sceneBindGroup);
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, bindGroup);
            pass.setVertexBuffer(0, skyBufs.posBuffer);
            pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
            pass.drawIndexed(skyBufs.idxCount);
            return 1;
        },
    };
}

// ─── HDR Skybox UBO ─────────────────────────────────────────────────────────────

function createSkyHdrMeshUBO(
    engine: EngineContextInternal,
    world: Float32Array,
    primaryColor: [number, number, number],
    skyOutputColor: [number, number, number],
    exposure: number,
    contrast: number
): GPUBuffer {
    const data = new Float32Array(SKY_HDR_UNIFORM_SIZE / 4);
    data.set(world, 0);
    data[16] = primaryColor[0];
    data[17] = primaryColor[1];
    data[18] = primaryColor[2];
    data[20] = skyOutputColor[0];
    data[21] = skyOutputColor[1];
    data[22] = skyOutputColor[2];
    data[24] = exposure; // exposureLinear
    data[25] = contrast; // contrast
    return createUniformBuffer(engine, data);
}
