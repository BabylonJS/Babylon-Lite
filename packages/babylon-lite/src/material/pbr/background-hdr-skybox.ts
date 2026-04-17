/** HDR cubemap skybox — lazy-loaded only when useCubemapSkybox is true.
 *  Contains the HDR skybox material, shader, UBO, and skybox geometry.
 *  Self-contained: computes scene bounds and builds a full Renderable.
 *  Tree-shaken away from scenes that use the default solid-color skybox. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Renderable } from "../../render/renderable.js";
import { createSkyboxBuffers, buildSkyboxWorldMatrix, computeSceneSize } from "./skybox-geometry.js";
import { createCubemapSkyboxMaterial } from "./cubemap-skybox-material.js";
import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxHdrFragSrc from "../../../shaders/skybox-hdr.fragment.wgsl?raw";
import { WGSL_SCENE_UNIFORMS_PBR } from "../../shader/wgsl-helpers.js";

const SKY_HDR_UNIFORM_SIZE = 112; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad + exposure + contrast + pad2

/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export function buildHdrSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    skyboxSize?: number
): Renderable {
    const engine = scene.engine as EngineContextInternal;

    const { skyboxSize: autoSkyboxSize, rootPosition } = computeSceneSize(scene, skyboxSize);
    const skyHalfSize = autoSkyboxSize / 2;
    const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);

    const cc = scene.clearColor;
    const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];

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
    const device = engine.device;
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
    const buf = device.createBuffer({
        size: SKY_HDR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data);
    return buf;
}
