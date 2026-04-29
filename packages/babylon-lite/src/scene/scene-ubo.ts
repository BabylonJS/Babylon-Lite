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
import { _getPbrLightExtension } from "../material/pbr/pbr-flags.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms.js";

/** Per-task scratch buffer cache to avoid per-frame allocation. */
const _scratchByTask = new WeakMap<RenderPassTask, Float32Array>();

/** Write the canonical SceneUniforms struct to the task's scene UBO.
 *  No dirty-tracking: we just write every frame because the per-task UBO
 *  is small (416 bytes) and writeBuffer batches well.
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

    const aspect = eng.canvas.width / eng.canvas.height;
    const viewProj = getViewProjectionMatrix(camera, aspect);
    const viewMat = getViewMatrix(camera);
    const camPos = getCameraPosition(camera);

    // SCENE_UBO float offsets (see shaders/scene-uniforms.wgsl):
    //   viewProjection  = 0    view             = 16   vEyePosition    = 32
    //   envRotationY    = 52   vSphericalL00    = 56   exposureLinear  = 92
    //   contrast        = 93   lodGenerationScale = 94 vFogInfos       = 96
    //   vFogColor       = 100
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
        data[96] = fog.mode;
        data[97] = fog.start;
        data[98] = fog.end;
        data[99] = fog.density;
        data[100] = fog.color[0]!;
        data[101] = fog.color[1]!;
        data[102] = fog.color[2]!;
    }

    // Light slot 0 (PBR uses; std uses its own lights UBO independently).
    const ext = _getPbrLightExtension();
    const light0 = scene.lights[0];
    if (ext && light0) {
        ext.writeSceneUbo(data, light0);
    }

    // Environment / IBL.
    const envTextures = scene._envTextures;
    data[52] = scene.envRotationY ?? 0;
    if (envTextures?.sphericalHarmonics) {
        data.set(envTextures.sphericalHarmonics, 56);
    }

    // Image processing.
    data[92] = scene.imageProcessing.exposure;
    data[93] = scene.imageProcessing.contrast;
    data[94] = envTextures?.lodGenerationScale ?? 0.8;

    eng.device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}
