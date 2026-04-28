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
import { SCENE_UBO_BYTES, SCENE_UBO_OFFSETS } from "../shader/scene-uniforms-fields.js";

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

    const O = SCENE_UBO_OFFSETS;
    const aspect = eng.canvas.width / eng.canvas.height;
    const viewProj = getViewProjectionMatrix(camera, aspect);
    const viewMat = getViewMatrix(camera);
    const camPos = getCameraPosition(camera);

    data.set(viewProj, O.viewProjection);
    // Y-flip for offscreen passes — negate row 1 of the projection (the multiplied
    // view*proj matrix). Row 1 of a column-major mat4 lives at indices 1,5,9,13.
    if (task._targetSignature.flipY) {
        const o = O.viewProjection;
        data[o + 1] = -data[o + 1]!;
        data[o + 5] = -data[o + 5]!;
        data[o + 9] = -data[o + 9]!;
        data[o + 13] = -data[o + 13]!;
    }
    data.set(viewMat, O.view);
    data[O.vEyePosition] = camPos.x;
    data[O.vEyePosition + 1] = camPos.y;
    data[O.vEyePosition + 2] = camPos.z;

    // Fog (std uses; pbr ignores).
    const fog = scene.fog;
    if (fog) {
        data[O.vFogInfos] = fog.mode;
        data[O.vFogInfos + 1] = fog.start;
        data[O.vFogInfos + 2] = fog.end;
        data[O.vFogInfos + 3] = fog.density;
        data[O.vFogColor] = fog.color[0]!;
        data[O.vFogColor + 1] = fog.color[1]!;
        data[O.vFogColor + 2] = fog.color[2]!;
    }

    // Light slot 0 (PBR uses; std uses its own lights UBO independently).
    const ext = _getPbrLightExtension();
    const light0 = scene.lights[0];
    if (ext && light0) {
        ext.writeSceneUbo(data, light0);
    }

    // Environment / IBL.
    const envTextures = scene._envTextures;
    data[O.envRotationY] = scene.envRotationY ?? 0;
    if (envTextures?.sphericalHarmonics) {
        data.set(envTextures.sphericalHarmonics, O.vSphericalL00);
    }

    // Image processing.
    data[O.exposureLinear] = scene.imageProcessing.exposure;
    data[O.contrast] = scene.imageProcessing.contrast;
    data[O.lodGenerationScale] = envTextures?.lodGenerationScale ?? 0.8;

    eng.device.queue.writeBuffer(task._sceneUBO, 0, data as Float32Array<ArrayBuffer>);
}
