// Slug GPU Font — Vertex Shader (WGSL, instanced layout).
// Direct port of Eric Lengyel's Slug dilation (see https://github.com/EricLengyel/Slug
// and Babylon.js-3/packages/dev/addons/src/msdfText/shadersWGSL/slug.vertex.fx).
// Per-vertex: corner sign (-1/+1 on each axis) — drives both the quad corner
// expansion and the dilation normal direction.
// Per-instance: bounds (em-space), anchor (object-space) + invScale, atlas locs, band transform.

struct TextU {
worldMatrix: mat4x4<f32>,
viewport: vec4<f32>,
color: vec4<f32>,
};
@group(1) @binding(0) var<uniform> textU: TextU;

struct VIn {
@location(0) slugCorner: vec2<f32>,
@location(1) slugBounds: vec4<f32>,
@location(2) slugAnchor: vec4<f32>,
@location(3) slugAtlas: vec4<f32>,
@location(4) slugBand: vec4<f32>,
};

struct VOut {
@builtin(position) pos: vec4<f32>,
@location(0) vTexcoord: vec2<f32>,
@location(1) @interpolate(flat) vBanding: vec4<f32>,
@location(2) @interpolate(flat) vGlyph: vec4<f32>,
@location(3) @interpolate(flat) vColor: vec4<f32>,
};

@vertex
fn main(in: VIn) -> VOut {
// Reconstruct per-vertex data from the shared corner quad + per-instance fields.
// Reference shader had: pos (object-space xy), normal (dilation direction xy),
// tex (em-space xy), invScale, MVP matrix.
let isMax = vec2<f32>(step(0.0, in.slugCorner.x), step(0.0, in.slugCorner.y));
let tex = mix(in.slugBounds.xy, in.slugBounds.zw, isMax);
let invScale = in.slugAnchor.z;
let scale = select(0.0, 1.0 / invScale, invScale != 0.0);
let pos = in.slugAnchor.xy + tex * scale;
let normal = in.slugCorner;
let jac = vec4<f32>(invScale, 0.0, 0.0, invScale);

let mvp = scene.viewProjection * textU.worldMatrix;

// Extract MVP matrix rows from column-major storage.
let row0 = vec4<f32>(mvp[0].x, mvp[1].x, mvp[2].x, mvp[3].x);
let row1 = vec4<f32>(mvp[0].y, mvp[1].y, mvp[2].y, mvp[3].y);
let row3 = vec4<f32>(mvp[0].w, mvp[1].w, mvp[2].w, mvp[3].w);

// Dynamic dilation (SlugDilate) — verbatim from the reference shader.
let n = normalize(normal);
let s = dot(row3.xy, pos) + row3.w;
let t_val = dot(row3.xy, n);

let u = (s * dot(row0.xy, n) - t_val * (dot(row0.xy, pos) + row0.w)) * textU.viewport.x;
let v = (s * dot(row1.xy, n) - t_val * (dot(row1.xy, pos) + row1.w)) * textU.viewport.y;

let s2 = s * s;
let st = s * t_val;
let uv = u * u + v * v;
let d = normal * (s2 * (st + sqrt(uv)) / (uv - st * st));

let dilatedPos = pos + d;
let dilatedTex = vec2<f32>(tex.x + dot(d, jac.xy), tex.y + dot(d, jac.zw));

var out: VOut;
out.pos = mvp * vec4<f32>(dilatedPos, 0.0, 1.0);
out.vTexcoord = dilatedTex;
out.vBanding = in.slugBand;
out.vGlyph = in.slugAtlas;
out.vColor = textU.color;
return out;
}
