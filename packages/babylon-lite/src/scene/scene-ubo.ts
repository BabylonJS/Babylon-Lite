/** Per-pass scene UBO writer.
 *
 * Owns the data layout for the canonical SceneUniforms struct:
 * camera matrices, eye position, fog, light slot 0, env rotation,
 * spherical harmonics, image processing.
 *
 * Called once per frame per RenderPassTask, with the task's resolved
 * camera (`task.camera ?? scene.camera`). When the task is offscreen
 * (not resolving to swapchain), the projection matrix's Y is flipped
 * so that subsequent sampling of the result texture appears upright;
 * pipelines compensate by inverting frontFace via `sig.flipY`.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "./scene-core.js";
import type { Camera } from "../camera/camera.js";
import type { RenderPassTask } from "../frame-graph/render-pass-task.js";

import { getViewProjectionMatrix, getViewMatrix, getCameraPosition } from "../camera/camera.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";

/** Per-task scratch buffer cache to avoid per-frame allocation. */
const _scratchByTask = new WeakMap<RenderPassTask, Float32Array>();

/** Write the canonical SceneUniforms struct to the task's scene UBO.
 *  No dirty-tracking: we just write every frame because the per-task UBO
 *  is small (352 bytes) and writeBuffer batches well.
 *
 *  Note: light/env data is written even for std-only scenes (those fields
 *  stay zero — std shaders simply don't reference them). This keeps a
 *  single writer for both material families.
 */
export function writePassSceneUBO(task: RenderPassTask, eng: EngineContextInternal, scene: SceneContextInternal, camera: Camera | null): void {
    if (!camera) {
        return;
    }
    let data = _scratchByTask.get(task);
    if (!data) {
        data = new Float32Array(SCENE_UBO_BYTES / 4);
        _scratchByTask.set(task, data);
    }
    data.fill(0);

    const v = camera.viewport;
    const aspect = (eng.canvas.width / eng.canvas.height) * (v ? v.width / v.height : 1);
    const viewProj = getViewProjectionMatrix(camera, aspect);
    const viewMat = getViewMatrix(camera);
    const camPos = getCameraPosition(camera);

    // SCENE_UBO float offsets (see shaders/scene-uniforms.wgsl):
    //   viewProjection  = 0    view             = 16   vEyePosition    = 32
    //   envRotationY    = 36   vSphericalL00    = 40   exposureLinear  = 76
    //   contrast        = 77   lodGenerationScale = 78 vFogInfos       = 80
    //   vFogColor       = 84
    data.set(viewProj, 0);
    // Y-flip for offscreen passes — negate row 1 of the projection (the multiplied
    // view*proj matrix). Row 1 of a column-major mat4 lives at indices 1,5,9,13.
    if (task._targetSignature.flipY) {
        data[1] = -data[1]!;
        data[5] = -data[5]!;
        data[9] = -data[9]!;
        data[13] = -data[13]!;
    }
    data.set(viewMat, 16);
    data[32] = camPos.x;
    data[33] = camPos.y;
    data[34] = camPos.z;

    // Fog (std uses; pbr ignores).
    const fog = scene.fog;
    if (fog) {
        data[80] = fog.mode;
        data[81] = fog.start;
        data[82] = fog.end;
        data[83] = fog.density;
        data[84] = fog.color[0]!;
        data[85] = fog.color[1]!;
        data[86] = fog.color[2]!;
    }

    // Light data is no longer written to the SCENE_UBO. PBR + Standard both
    // read all lights exclusively from the shared lights UBO (render/lights-ubo.ts).
    // Environment / IBL.
    const envTextures = scene._envTextures;
    data[36] = scene.envRotationY ?? 0;
    if (envTextures?.sphericalHarmonics) {
        data.set(envTextures.sphericalHarmonics, 40);
    }

    // Image processing.
    data[76] = scene.imageProcessing.exposure;
    data[77] = scene.imageProcessing.contrast;
    data[78] = envTextures?.lodGenerationScale ?? 0.8;

    eng.device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}
