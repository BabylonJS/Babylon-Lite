/**
 * AnchoredSpriteLayer WGSL composer.
 *
 * Anchored sprites project a world anchor through the 3D viewProjection, then
 * expand a pixel-sized quad in clip space. The screen size is invariant to
 * camera distance — multiplication by `anchorClip.w` cancels the perspective
 * divide.
 *
 * Composition variables:
 *  - PIXEL_SNAP — bake `floor(p + 0.5)` for the pixel offset when enabled.
 *  - CUTOFF     — `cutout` blend mode discards fragments below `alphaCutoff`.
 *  - RETURN     — `multiply` blend mode pre-weights RGB by alpha.
 *
 * Shares the Sprite3DSceneUBO from `shared/sprite-3d-scene-ubo.ts` (single per-scene
 * UBO at @group(0) @binding(0) — see that file for the chosen binding model).
 */

import type { SpriteBlendMode } from "./shared/sprite-atlas.js";
import { SPRITE_3D_SCENE_UBO_WGSL } from "./shared/sprite-3d-scene-ubo.js";
import { SPRITE_3D_DATA_WGSL, SPRITE_3D_VS_IN_WGSL } from "./shared/sprite-3d-instance-wgsl.js";

export interface AnchoredSpriteShaderOptions {
    pixelSnap: boolean;
    blendMode: SpriteBlendMode;
    /** Required only for `cutout`. */
    alphaCutoff?: number;
}

export interface ComposedAnchoredSpriteShader {
    vertexWGSL: string;
    fragmentWGSL: string;
}

export function composeAnchoredSprite(opts: AnchoredSpriteShaderOptions): ComposedAnchoredSpriteShader {
    const snap = opts.pixelSnap ? "let snapped = floor(rotated + vec2<f32>(0.5));" : "let snapped = rotated;";

    const vertexWGSL = /* wgsl */ `
${SPRITE_3D_SCENE_UBO_WGSL}
@group(0) @binding(0) var<uniform> scene: Sprite3DSceneUBO;
${SPRITE_3D_DATA_WGSL}
${SPRITE_3D_VS_IN_WGSL}

@vertex
fn vs_main(in: VSIn) -> VSOut {
    let s = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let anchorClip = scene.viewProjection * vec4<f32>(s.worldPos, 1.0);
    let localPx = (corner - s.pivot) * s.sizePxOrWorld + s.offsetPx_or_reserved;
    let rotated = rotate2(localPx, s.sinCos);
    ${snap}
    let ndcOffset = vec2<f32>(
         snapped.x * scene.invViewportPx.x * 2.0,
        -snapped.y * scene.invViewportPx.y * 2.0
    );
    let uv = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    var out: VSOut;
    out.pos = vec4<f32>(
        anchorClip.x + ndcOffset.x * anchorClip.w,
        anchorClip.y + ndcOffset.y * anchorClip.w,
        anchorClip.z + s.depthBias_or_reserved * anchorClip.w,
        anchorClip.w
    );
    out.uv = uv;
    out.color = s.color;
    return out;
}
`;

    const cutoff = opts.blendMode === "cutout" ? `if (c.a < ${(opts.alphaCutoff ?? 0.5).toFixed(6)}) { discard; }` : "";
    const returnStmt = opts.blendMode === "multiply" ? "return vec4<f32>(c.rgb * c.a, c.a);" : "return c;";

    const fragmentWGSL = /* wgsl */ `
struct SpriteLayerUBO {
    opacity: f32,
    _pad: vec3<f32>,
};
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUBO;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    var c = textureSample(atlasTex, atlasSamp, in.uv) * in.color;
    c.a = c.a * layer.opacity;
    ${cutoff}
    ${returnStmt}
}
`;

    return { vertexWGSL, fragmentWGSL };
}
