/** Skybox renderable for cube-texture skyboxes (standard-material scenes).
 *  Wraps the existing skybox-cubemap material into a Renderable. */

import type { SceneContext } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { SkyboxData } from "./load-skybox.js";
import type { Renderable } from "../render/renderable.js";
import { buildSkyboxCubeMapGPU } from "../material/standard/skybox-cubemap.js";

/** Build a skybox Renderable from a SkyboxData (loaded via loadSkybox). */
export function buildSkyboxRenderable(scene: SceneContext, skybox: SkyboxData, sceneUBO: GPUBuffer): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;

    const gpu = buildSkyboxCubeMapGPU(device, engine.format, engine.msaaSamples, sceneUBO, skybox.worldMatrix, skybox.cubeView, skybox.cubeSampler);

    return {
        order: 0, // skybox behind everything
        isTransparent: false,
        draw(pass) {
            pass.setBindGroup(0, gpu.sceneBindGroup);
            pass.setPipeline(gpu.pipeline);
            pass.setBindGroup(1, gpu.meshBindGroup);
            pass.setVertexBuffer(0, skybox.posBuffer);
            pass.setVertexBuffer(1, skybox.normBuffer);
            pass.setIndexBuffer(skybox.idxBuffer, "uint32");
            pass.drawIndexed(skybox.idxCount);
            return 1;
        },
    };
}
