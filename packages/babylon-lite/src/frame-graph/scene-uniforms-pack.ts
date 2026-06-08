/** Canonical SceneUniforms packing.
 *
 *  Fills a Float32Array with the full SceneUniforms struct (see
 *  shaders/scene-uniforms.wgsl) from the live scene + camera. Shared by the
 *  forward {@link RenderTask} and the {@link createGeometryRendererTask} so the
 *  PBR geometry pass (real-colour + irradiance attachments) sees the same
 *  IBL spherical-harmonics, image-processing (exposure / contrast / tonemap),
 *  env rotation, fog and clip-plane state as the forward render. */

import type { Camera } from "../camera/camera.js";
import { getViewProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";

/** Pack the always-present SceneUniforms fields into `data` (length
 *  SCENE_UBO_BYTES/4). Zeroes the buffer first, then writes the universal
 *  camera / eye / env-rotation / image-processing fields every scene needs.
 *
 *  The opt-in fog (offsets 80–86), clip-plane (88–91) and IBL spherical-
 *  harmonics (40–75) slices are NOT written here — they are owned by the
 *  scene-UBO contributors registered through the {@link setFog}/{@link
 *  setClipPlane}/env-loader seam. The forward {@link RenderTask} and the
 *  {@link createGeometryRendererTask} run those contributors after this base
 *  pack, so fog/clip/env code only ships in scenes that actually use them.
 *  Pure — does not touch the GPU. */
export function _packSceneUniforms(data: Float32Array, eng: EngineContext, scene: SceneContext, camera: Camera, aspect: number): void {
    data.fill(0);

    const viewProj = getViewProjectionMatrix(camera, aspect);
    const viewMat = getViewMatrix(camera);
    const wm = camera.worldMatrix;

    // SCENE_UBO float offsets (see shaders/scene-uniforms.wgsl):
    //   viewProjection  = 0    view             = 16   vEyePosition    = 32
    //   envRotationY    = 36   vSphericalL00    = 40   exposureLinear  = 76
    //   contrast        = 77   lodGenerationScale = 78 vFogInfos       = 80
    //   vFogColor       = 84   clipPlane        = 88
    packMat4IntoF32(data, viewProj, 0);
    packMat4IntoF32(data, viewMat, 16);

    if (eng.useFloatingOrigin) {
        data[32] = 0;
        data[33] = 0;
        data[34] = 0;
    } else {
        data[32] = wm[12]!;
        data[33] = wm[13]!;
        data[34] = wm[14]!;
    }

    data[87] = eng.canvas.width;

    data[36] = scene.envRotationY || 0;
    const envTextures = scene._envTextures;

    const img = scene.imageProcessing;
    data[76] = img.exposure;
    data[77] = img.contrast;
    data[78] = envTextures?.lodGenerationScale ?? 0.8;
    data[79] = +img.toneMappingEnabled;
    data[37] = eng.canvas.height;
}
