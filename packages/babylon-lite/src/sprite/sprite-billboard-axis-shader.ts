/**
 * Axis-locked billboard WGSL composer.
 *
 * Vertex shader builds the right basis from the lock axis (read from the
 * `AxisLockedBillboardSystemUBO` at `@group(1) @binding(2)`, replacing the
 * per-layer `SpriteLayerUBO`) and the camera-projected forward direction.
 *
 * Edge case: when `toCam` is parallel to the lock axis, the projected forward
 * collapses; we fall back to a deterministic perpendicular so the basis stays
 * orthonormal.
 */

import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { SPRITE_3D_SCENE_UBO_WGSL } from "./shared/sprite-3d-scene-ubo.js";
import { AXIS_LOCKED_SYSTEM_UBO_WGSL, BILLBOARD_VS_IN_WGSL, buildBillboardFragmentWGSL } from "./shared/sprite-billboard-wgsl.js";

export interface AxisBillboardShaderOptions {
    blendMode: SpriteBlendMode;
    alphaCutoff?: number;
}

export interface ComposedBillboardShader {
    vertexWGSL: string;
    fragmentWGSL: string;
}

export function composeAxisLockedBillboard(opts: AxisBillboardShaderOptions): ComposedBillboardShader {
    const vertexWGSL = /* wgsl */ `
${SPRITE_3D_SCENE_UBO_WGSL}
${AXIS_LOCKED_SYSTEM_UBO_WGSL}
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;
@group(1) @binding(2) var<uniform> system: SpriteLayerUniforms;

${BILLBOARD_VS_IN_WGSL}

@vertex
fn vs_main(in: VSIn) -> VSOut {
    let s = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    let camPos = vec3<f32>(scene.cameraRight.w, scene.cameraUp.w, scene.cameraForward.w);
    let a = normalize(system.lockAxis);
    let toCam = normalize(camPos - s.worldPos);
    // Project camera direction onto the plane perpendicular to the axis.
    let fRaw = toCam - a * dot(toCam, a);
    let fLen = length(fRaw);
    // Degenerate case (toCam parallel to axis) — fall back to a deterministic
    // perpendicular so the basis stays orthonormal.
    let fallback = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(a.x) < 0.9);
    let f = select(fallback, fRaw / max(fLen, 1e-6), fLen > 1e-4);
    let right = normalize(cross(a, f));
    let world = s.worldPos + right * rotated.x + a * rotated.y;
    var out: VSOut;
    out.pos = scene.viewProjection * vec4<f32>(world, 1.0);
    out.uv = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.color = s.color;
    return out;
}
`;

    return {
        vertexWGSL,
        fragmentWGSL: buildBillboardFragmentWGSL(opts.blendMode, opts.alphaCutoff ?? 0.5, AXIS_LOCKED_SYSTEM_UBO_WGSL),
    };
}
