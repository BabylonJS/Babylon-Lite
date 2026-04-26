/** High-level skybox loader.
 *  Loads a cube texture and registers a skybox for the auto-builder. */

import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { loadCubeTexture } from "../texture/cube-texture.js";
import { createBoxData } from "../mesh/create-box.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";

/** Skybox data stored on the scene for the auto-builder. */
export interface SkyboxData {
    cubeView: GPUTextureView;
    cubeSampler: GPUSampler;
    posBuffer: GPUBuffer;
    normBuffer: GPUBuffer;
    idxBuffer: GPUBuffer;
    idxCount: number;
    worldMatrix: Float32Array;
}

/** Load a skybox cube texture and register it on the scene.
 *  The auto-builder will create the pipeline and render it.
 *
 *  @param scene   - Scene to register the skybox in
 *  @param baseUrl - Base URL for cube faces (e.g., 'textures/skybox')
 *  @param ext     - File extension (e.g., '.jpg', '.png')
 *  @param size    - Box size (default 100, matches Babylon)
 */
export async function loadSkybox(scene: SceneContext, baseUrl: string, ext: string, size = 100): Promise<void> {
    const eng = scene.engine as EngineContextInternal;

    const cubeTex = await loadCubeTexture(eng, baseUrl, ext);

    const boxData = createBoxData(size);
    const posBuffer = createMappedBuffer(eng, boxData.positions, GPUBufferUsage.VERTEX);
    const normBuffer = createMappedBuffer(eng, boxData.normals, GPUBufferUsage.VERTEX);
    const idxBuffer = createMappedBuffer(eng, boxData.indices, GPUBufferUsage.INDEX);

    const world = new Float32Array(16);
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;

    const skyboxData: SkyboxData = {
        cubeView: cubeTex.view,
        cubeSampler: cubeTex.sampler,
        posBuffer,
        normBuffer,
        idxBuffer,
        idxCount: boxData.indices.length,
        worldMatrix: world,
    };
    (scene as SceneContextInternal)._skybox = skyboxData;

    // Register deferred builder — skybox renderable built at startEngine() time.
    // Must run AFTER the standard mesh builder (which stashes _standardSceneUBO).
    // If the UBO isn't ready yet (parallel execution), re-enqueue for the next pass.
    (scene as SceneContextInternal)._deferredBuilders.push(async () => {
        const { buildSkyboxRenderable } = await import("./skybox-renderable.js");
        const sceneUBO = (scene as SceneContextInternal)._standardSceneUBO;
        if (sceneUBO) {
            (scene as SceneContextInternal)._renderables.push(buildSkyboxRenderable(scene, skyboxData, sceneUBO));
        } else {
            // UBO not yet created — re-enqueue so _build() picks us up in the next pass
            (scene as SceneContextInternal)._deferredBuilders.push(async () => {
                const ubo = (scene as SceneContextInternal)._standardSceneUBO;
                if (ubo) {
                    (scene as SceneContextInternal)._renderables.push(buildSkyboxRenderable(scene, skyboxData, ubo));
                }
            });
        }
    });
}
