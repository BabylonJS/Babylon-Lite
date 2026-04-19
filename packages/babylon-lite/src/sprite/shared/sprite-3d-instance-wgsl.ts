/**
 * Shared WGSL helpers for 3D sprite vertex shaders (anchored + billboards).
 *
 * Per blocker 4 of docs/architecture/26-sprites.md, all 3D sprite renderables
 * read their per-instance data from a single storage buffer at
 * `@group(1) @binding(3)`, indexed by a per-instance Uint32 sort indirection
 * attribute at `@location(0)`. This lets blended layers re-sort back-to-front
 * each frame without ever touching the packed sprite data buffer.
 *
 * The packed layout is the 24-float / 96-byte stride described in the spec.
 * Both anchored and billboard variants share the same struct (the field
 * meanings differ slightly — see comments in `sprite-anchored.ts` and
 * `sprite-billboard-shared.ts`). Treating them as identical at the WGSL level
 * keeps the shared helpers tiny.
 */

/** Storage buffer record — 96 B, matches `SPRITE_*_STRIDE` (24 floats).
 *  Anchored uses `f01.x` as `depthBias` and `f12.xy` as `offsetPx`; billboards
 *  treat both as reserved (packed as 0 by `packSlot`). `f12.zw` is `sizePx`
 *  for anchored and `sizeWorld` for billboards. */
export const SPRITE_3D_DATA_WGSL = /* wgsl */ `
struct SpriteData {
    worldPos: vec3<f32>,
    depthBias_or_reserved: f32,
    offsetPx_or_reserved: vec2<f32>,
    sizePxOrWorld: vec2<f32>,
    pivot: vec2<f32>,
    sinCos: vec2<f32>,
    uvRect: vec4<f32>,
    color: vec4<f32>,
    flagsAndPad: vec4<f32>,
};
@group(1) @binding(3) var<storage, read> sprites: array<SpriteData>;
`;

/** Per-vertex inputs: vertex_index for the 6-corner expansion, plus the
 *  per-instance Uint32 sort indirection at @location(0). */
export const SPRITE_3D_VS_IN_WGSL = /* wgsl */ `
struct VSIn {
    @builtin(vertex_index) vid: u32,
    @location(0) sortIndex: u32,
};

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(p.x * sinCos.y - p.y * sinCos.x, p.x * sinCos.x + p.y * sinCos.y);
}

fn cornerOf(vid: u32) -> vec2<f32> {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
    );
    return corners[vid];
}

fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: f32, flipY: f32) -> vec2<f32> {
    var u = mix(rect.x, rect.z, corner.x);
    var v = mix(rect.y, rect.w, corner.y);
    if (flipX > 0.5) { u = rect.x + rect.z - u; }
    if (flipY > 0.5) { v = rect.y + rect.w - v; }
    return vec2<f32>(u, v);
}
`;
