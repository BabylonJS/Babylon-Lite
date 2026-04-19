/**
 * Facing (spherical) billboard WGSL composer.
 *
 * Vertex shader uses pre-extracted `cameraRight` and `cameraUp` from the
 * shared `Sprite3DSceneUBO` — no basis math beyond a 2D rotation.
 */

import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { SPRITE_3D_SCENE_UBO_WGSL } from "./shared/sprite-3d-scene-ubo.js";
import { BILLBOARD_VS_IN_WGSL, SPRITE_LAYER_UBO_WGSL, buildBillboardFragmentWGSL } from "./shared/sprite-billboard-wgsl.js";

export interface FacingBillboardShaderOptions {
    blendMode: SpriteBlendMode;
    alphaCutoff?: number;
}

export interface ComposedBillboardShader {
    vertexWGSL: string;
    fragmentWGSL: string;
}

export function composeFacingBillboard(opts: FacingBillboardShaderOptions): ComposedBillboardShader {
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
    let world = s.worldPos
              + scene.cameraRight.xyz * rotated.x
              + scene.cameraUp.xyz    * rotated.y;
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
