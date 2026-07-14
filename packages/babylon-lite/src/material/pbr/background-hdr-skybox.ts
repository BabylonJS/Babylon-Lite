/** HDR cubemap skybox — lazy-loaded only when useCubemapSkybox is true.
 *  Contains the HDR skybox material, shader, UBO, and skybox geometry.
 *  Self-contained: computes scene bounds and builds a full Renderable.
 *  Tree-shaken away from scenes that use the default solid-color skybox. */

import { F32, U16 } from "../../engine/typed-arrays.js";
import { BU } from "../../engine/gpu-flags.js";
import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Renderable } from "../../render/renderable.js";
import { createCubemapSkyboxMaterial } from "./cubemap-skybox-material.js";
import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxHdrFragSrc from "../../../shaders/skybox-hdr.fragment.wgsl?raw";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";

const SKY_HDR_UNIFORM_SIZE = 112; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad + exposure + contrast + pad2

function createSkyboxBuffers(engine: EngineContext, S: number): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer } {
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
    return {
        posBuffer: createMappedBuffer(engine, positions, BU.VERTEX),
        idxBuffer: createMappedBuffer(engine, indices, BU.INDEX),
    };
}

/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export function buildHdrSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    skyHalfSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number]
): Renderable {
    const engine = scene.surface.engine;

    const cc = scene.clearColor;

    const skyBufs = createSkyboxBuffers(engine, skyHalfSize);
    const mat = createCubemapSkyboxMaterial("skybox-hdr", SCENE_UBO_WGSL + skyboxVertSrc, skyboxHdrFragSrc);
    const ubo = createSkyHdrMeshUBO(engine, rootPosition, primaryColor, [cc.r, cc.g, cc.b], scene.imageProcessing.exposure, scene.imageProcessing.contrast);

    const bindGroup = mat.createBindGroup(engine, ubo, envTextures.specularCubeView!, envTextures.cubeSampler);

    const r: Renderable = {
        order: 0,
        isTransparent: false,
        bind(eng, sig) {
            return {
                renderable: r,
                pipeline: mat.getPipeline(eng as EngineContext, sig),
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, skyBufs.posBuffer);
                    pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
                    pass.drawIndexed(36);
                    return 1;
                },
            };
        },
    };
    return r;
}

// ─── HDR Skybox UBO ─────────────────────────────────────────────────────────────

function createSkyHdrMeshUBO(
    engine: EngineContext,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number],
    skyOutputColor: [number, number, number],
    exposure: number,
    contrast: number
): GPUBuffer {
    const data = new F32(SKY_HDR_UNIFORM_SIZE / 4);
    data[0] = data[5] = data[10] = data[15] = 1;
    data[12] = rootPosition[0];
    data[13] = rootPosition[1];
    data[14] = rootPosition[2];
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
