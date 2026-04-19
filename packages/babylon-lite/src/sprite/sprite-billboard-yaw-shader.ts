/**
 * Yaw-locked (cylindrical) billboard WGSL composer.
 *
 * Vertex shader builds the right basis from `cameraPosition` (packed in
 * `Sprite3DSceneUBO.cameraRight.w / cameraUp.w / cameraForward.w`) crossed
 * with world Y. Up is always world-Y, so trees and pillars stay vertical.
 *
 * Edge case: when the camera is directly above or below the sprite,
 * `toCam ≈ ±worldY` and `cross(worldY, toCam) ≈ 0`. We fall back to the
 * world X axis in that case so the basis stays orthonormal.
 */

import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { SPRITE_3D_SCENE_UBO_WGSL } from "./shared/sprite-3d-scene-ubo.js";
import { BILLBOARD_VS_IN_WGSL, SPRITE_LAYER_UBO_WGSL, buildBillboardFragmentWGSL } from "./shared/sprite-billboard-wgsl.js";

export interface YawBillboardShaderOptions {
    blendMode: SpriteBlendMode;
    alphaCutoff?: number;
}

export interface ComposedBillboardShader {
    vertexWGSL: string;
    fragmentWGSL: string;
}

export function composeYawLockedBillboard(opts: YawBillboardShaderOptions): ComposedBillboardShader {
    const vertexWGSL = /* wgsl */ `
${SPRITE_3D_SCENE_UBO_WGSL}
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;

${BILLBOARD_VS_IN_WGSL}

@vertex
fn vs_main(in: VSIn) -> VSOut {
    let s = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let toCam = normalize(camPos - s.worldPos);
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let rightRaw = cross(up, toCam);
    let rightLen = length(rightRaw);
    // Degenerate case (camera directly overhead/below) — fall back to world X.
    let right = select(vec3<f32>(1.0, 0.0, 0.0), rightRaw / max(rightLen, 1e-6), rightLen > 1e-4);
    let world = s.worldPos + right * rotated.x + up * rotated.y;
    var out: VSOut;
    out.pos = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.color = s.color;
    return out;
}
`;

    return {
        vertexWGSL,
        fragmentWGSL: buildBillboardFragmentWGSL(opts.blendMode, opts.alphaCutoff ?? 0.5, SPRITE_LAYER_UBO_WGSL),
    };
}
