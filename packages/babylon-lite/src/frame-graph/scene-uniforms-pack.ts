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

/** Pack the canonical SceneUniforms layout into `data` (length SCENE_UBO_BYTES/4).
 *  Zeroes the buffer first, then writes every field the PBR/Standard fragment
 *  shaders read. Pure — does not touch the GPU. */
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
    data[87] = eng.canvas.width;

    const envRotationY = scene.envRotationY || 0;
    data[36] = envRotationY;
    const envTextures = scene._envTextures;
    if (envTextures?.sphericalHarmonics) {
        data.set(envTextures.sphericalHarmonics, 40);
    }

    const img = scene.imageProcessing;
    data[76] = img.exposure;
    data[77] = img.contrast;
    data[78] = envTextures?.lodGenerationScale ?? 0.8;
    data[79] = +img.toneMappingEnabled;
    data[37] = eng.canvas.height;

    if (scene.clipPlane) {
        data[88] = scene.clipPlane[0];
        data[89] = scene.clipPlane[1];
        data[90] = scene.clipPlane[2];
        data[91] = scene.clipPlane[3];
    }
}
