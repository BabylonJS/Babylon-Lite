/** HDR cubemap skybox — lazy-loaded only when useCubemapSkybox is true.
 *  Contains the HDR skybox shader wiring and UBO; cube geometry and the Renderable
 *  shell are shared with the DDS skybox via cubemap-skybox-material.
 *  Self-contained: computes scene bounds and builds a full Renderable.
 *  Tree-shaken away from scenes that use the default solid-color skybox. */

import { F32 } from "../../engine/typed-arrays.js";
import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Renderable } from "../../render/renderable.js";
import { composeSkyboxFragment, createCubemapSkyboxMaterial, createCubemapSkyboxRenderable, createSkyboxBuffers } from "./cubemap-skybox-material.js";
import skyboxVertSrc from "../../../shaders/skybox.vertex.wgsl?raw";
import skyboxHdrFragSrc from "../../../shaders/skybox-hdr.fragment.wgsl?raw";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";

const SKY_HDR_UNIFORM_SIZE = 112; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad + exposure + contrast + pad2

/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export async function buildHdrSkyboxRenderable(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    skyHalfSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number]
): Promise<Renderable> {
    const engine = scene.surface.engine;

    const [positionBuffer, indexBuffer] = createSkyboxBuffers(engine, skyHalfSize);
    const skyboxFragment = await composeSkyboxFragment(scene, skyboxHdrFragSrc, "hdr");
    const mat = createCubemapSkyboxMaterial("skybox-hdr", SCENE_UBO_WGSL + skyboxVertSrc, skyboxFragment);
    const ubo = createSkyHdrMeshUBO(engine, rootPosition, primaryColor, scene.clearColor, scene.imageProcessing.exposure, scene.imageProcessing.contrast);

    const bindGroup = mat.createBindGroup(engine, ubo, envTextures.specularCubeView!, envTextures.cubeSampler);

    return createCubemapSkyboxRenderable(mat, bindGroup, positionBuffer, indexBuffer, () => buildHdrSkyboxRenderable(scene, envTextures, skyHalfSize, rootPosition, primaryColor));
}

// ─── HDR Skybox UBO ─────────────────────────────────────────────────────────────

function createSkyHdrMeshUBO(
    engine: EngineContext,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number],
    skyOutputColor: GPUColorDict,
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
    data[20] = skyOutputColor.r;
    data[21] = skyOutputColor.g;
    data[22] = skyOutputColor.b;
    data[24] = exposure; // exposureLinear
    data[25] = contrast; // contrast
    return createUniformBuffer(engine, data);
}
