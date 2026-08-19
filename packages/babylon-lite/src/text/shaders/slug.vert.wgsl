// Slug GPU Font — Vertex Shader (WGSL, instanced layout).
// Direct port of Eric Lengyel's Slug dilation (see https://github.com/EricLengyel/Slug
// and Babylon.js-3/packages/dev/addons/src/msdfText/shadersWGSL/slug.vertex.fx).
// Per-vertex: corner sign (-1/+1 on each axis) — drives both the quad corner
// expansion and the dilation normal direction.
// Per-instance: anchor (object-space) + invScale, glyph index, color. Everything that depends
// only on the glyph (em-space bounds, atlas location, band transform) is fetched from the
// shared glyphMetadata table rather than duplicated into every instance.

struct TextU {
  mvp: mat4x4<f32>,
  viewport: vec4<f32>,
  // Whole-draw opacity in .a (rgb unused, always 1). Per-glyph color is the slugColor attribute.
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> textU: TextU;

// One entry per glyph in the curve-set's atlas, written once when the glyph is packed.
struct GlyphMetadata {
  // Em-space glyph bounds (xMin, yMin, xMax, yMax).
  bounds: vec4<f32>,
  // Band header texel location (x, y) and max band indices (x, y).
  atlas: vec4<f32>,
  // Em-space → band-space transform (scaleX, scaleY, offsetX, offsetY).
  band: vec4<f32>,
};
@group(0) @binding(3) var<storage, read> glyphMetadata: array<GlyphMetadata>;

struct VIn {
  @location(0) slugCorner: vec2<f32>,
  @location(1) slugAnchor: vec3<f32>,
  @location(2) slugGlyph: u32,
  @location(3) slugColor: vec4<f32>,
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
  // Dead-slot sentinel: the slot allocator marks freed slots with an all-ones glyph index
  // (live slots always hold a real index). Emit a clip-space point at -2 (outside the unit
  // cube) so all 6 vertices of the quad collapse to the same off-screen position and the
  // rasterizer culls the resulting zero-area triangles cheaply.
  if (in.slugGlyph == 0xffffffffu) {
    var dead: VOut;
    dead.pos = vec4<f32>(-2.0, -2.0, -2.0, 1.0);
    dead.vTexcoord = vec2<f32>(0.0, 0.0);
    dead.vBanding = vec4<f32>(0.0);
    dead.vGlyph = vec4<f32>(0.0);
    dead.vColor = vec4<f32>(0.0);
    return dead;
  }

  let md = glyphMetadata[in.slugGlyph];

  // Reconstruct per-vertex data from the shared corner quad + per-instance fields.
  // Reference shader had: pos (object-space xy), normal (dilation direction xy),
  // tex (em-space xy), invScale, MVP matrix.
  let isMax = vec2<f32>(step(0.0, in.slugCorner.x), step(0.0, in.slugCorner.y));
  let tex = mix(md.bounds.xy, md.bounds.zw, isMax);
  let invScale = in.slugAnchor.z;
  let scale = select(0.0, 1.0 / invScale, invScale != 0.0);
  let pos = in.slugAnchor.xy + tex * scale;
  let normal = in.slugCorner;
  let jac = vec4<f32>(invScale, 0.0, 0.0, invScale);

  let mvp = textU.mvp;

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
  out.vBanding = md.band;
  out.vGlyph = md.atlas;
  // Color comes entirely from the per-glyph instance attribute; the uniform contributes
  // only a whole-draw opacity multiply (textU.color is always (1,1,1,opacity)).
  out.vColor = vec4<f32>(in.slugColor.rgb, in.slugColor.a * textU.color.a);
  return out;
}
