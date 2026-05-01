/** Skybox renderable for cube-texture skyboxes (standard-material scenes).
 *  Wraps the existing skybox-cubemap material into a Renderable. */

import type { SceneContext } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { SkyboxData } from "./load-skybox.js";
import type { Renderable } from "../render/renderable.js";
import { buildSkyboxCubeMapGPU } from "../material/standard/skybox-cubemap.js";

/** Build a skybox Renderable from a SkyboxData (loaded via loadSkybox). */
export function buildSkyboxRenderable(scene: SceneContext, skybox: SkyboxData): Renderable {
    const engine = scene.engine as EngineContextInternal;

    const gpu = buildSkyboxCubeMapGPU(engine, skybox.worldMatrix, skybox.cubeView, skybox.cubeSampler);

    const r: Renderable = {
        order: 0, // skybox behind everything
        isTransparent: false,
        bind(eng, sig) {
            const pipeline = gpu.getPipeline(eng as EngineContextInternal, sig);
            return {
                renderable: r,
                pipeline,
                draw(pass) {
                    pass.setBindGroup(1, gpu.meshBindGroup);
                    pass.setVertexBuffer(0, skybox.posBuffer);
                    pass.setVertexBuffer(1, skybox.normBuffer);
                    pass.setIndexBuffer(skybox.idxBuffer, "uint32");
                    pass.drawIndexed(skybox.idxCount);
                    return 1;
                },
            };
        },
    };
    return r;
}
