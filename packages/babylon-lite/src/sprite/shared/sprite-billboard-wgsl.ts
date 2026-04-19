/**
 * Shared WGSL helpers for billboard sprite shader composers.
 *
 * Per blocker 4 of docs/architecture/26-sprites.md, the per-instance data is
 * read from a storage buffer at `@group(1) @binding(3)` (see
 * `sprite-3d-instance-wgsl.ts` for the struct layout). The vertex shader's
 * single per-instance attribute is the Uint32 sort indirection at @location(0).
 */

import type { SpriteBlendMode } from "./sprite-atlas.js";
import { SPRITE_3D_DATA_WGSL, SPRITE_3D_VS_IN_WGSL } from "./sprite-3d-instance-wgsl.js";

/** Shared 3D-sprite VS input + helpers + storage-buffer record. */
export const BILLBOARD_VS_IN_WGSL = /* wgsl */ `
${SPRITE_3D_DATA_WGSL}
${SPRITE_3D_VS_IN_WGSL}
`;

/** Build the shared sprite fragment WGSL. `layerStructWGSL` lets the
 *  axis-locked variant swap `SpriteLayerUBO` for `AxisLockedBillboardSystemUBO`
 *  without the fragment-side `c.a *= layer.opacity;` line changing — both
 *  expose `.opacity` at offset 0. */
export function buildBillboardFragmentWGSL(blendMode: SpriteBlendMode, alphaCutoff: number, layerStructWGSL: string): string {
    const cutoff = blendMode === "cutout" ? `if (c.a < ${alphaCutoff.toFixed(6)}) { discard; }` : "";
    const returnStmt = blendMode === "multiply" ? "return vec4<f32>(c.rgb * c.a, c.a);" : "return c;";
    return /* wgsl */ `
${layerStructWGSL}
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
@group(1) @binding(2) var<uniform> layer: SpriteLayerUniforms;

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
}

/** Layer UBO struct used by Facing + YawLocked variants (32 B alignment). */
export const SPRITE_LAYER_UBO_WGSL = /* wgsl */ `
struct SpriteLayerUniforms {
    opacity: f32,
    _pad: vec3<f32>,
};
`;

/** System UBO struct used by AxisLocked variant. Aliased as
 *  `SpriteLayerUniforms` so the shared fragment shader binds identically. */
export const AXIS_LOCKED_SYSTEM_UBO_WGSL = /* wgsl */ `
struct SpriteLayerUniforms {
    opacity: f32,
    alphaCutoff: f32,
    lockAxis: vec3<f32>,
    _pad: f32,
};
`;
