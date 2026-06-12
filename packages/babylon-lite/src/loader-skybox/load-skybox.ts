/** High-level skybox loader.
 *  Loads a cube texture and registers a skybox for the auto-builder. */

import { F32 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { SceneContext } from "../scene/scene.js";
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
    const eng = scene.surface.engine;

    const cubeTex = await loadCubeTexture(eng, baseUrl, ext);

    const boxData = createBoxData(size);
    const posBuffer = createMappedBuffer(eng, boxData.positions, BU.VERTEX);
    const normBuffer = createMappedBuffer(eng, boxData.normals, BU.VERTEX);
    const idxBuffer = createMappedBuffer(eng, boxData.indices, BU.INDEX);

    const world = new F32(16);
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

    // Build the skybox renderable inline — task supplies sceneBG at draw time, no ordering constraints.
    const { buildSkyboxRenderable } = await import("./skybox-renderable.js");
    scene._renderables.push(buildSkyboxRenderable(scene, skyboxData));
}
