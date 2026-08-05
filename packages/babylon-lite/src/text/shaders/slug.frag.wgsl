// Slug GPU Font — Fragment Shader (WGSL). Per-pixel coverage from quadratic Bézier bands.

@group(0) @binding(1) var curveTex: texture_2d<f32>;
@group(0) @binding(2) var bandTex: texture_2d<f32>;

struct TextU {
  mvp: mat4x4<f32>,
  viewport: vec4<f32>,
  // .a = whole-draw opacity. .x = coverage-gamma reciprocal (1/coverageGamma) applied to
  // anti-aliased edge coverage below. .yz unused.
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> textU: TextU;

struct FIn {
  @location(0) vTexcoord: vec2<f32>,
  @location(1) @interpolate(flat) vBanding: vec4<f32>,
  @location(2) @interpolate(flat) vGlyph: vec4<f32>,
  @location(3) @interpolate(flat) vColor: vec4<f32>,
  @builtin(front_facing) frontFacing: bool,
};

fn calcRootCode(y1: f32, y2: f32, y3: f32) -> i32 {
  let i1: i32 = select(0, 1, y1 < 0.0);
  let i2: i32 = select(0, 2, y2 < 0.0);
  let i3: i32 = select(0, 4, y3 < 0.0);
  let shift = u32(i1 + i2 + i3);
  return (0x2E74 >> shift) & 0x0101;
}

fn solveHorizPoly(p12: vec4<f32>, p3: vec2<f32>) -> vec2<f32> {
  let a = vec2<f32>(p12.x - p12.z * 2.0 + p3.x, p12.y - p12.w * 2.0 + p3.y);
  let b = vec2<f32>(p12.x - p12.z, p12.y - p12.w);
  let ra = 1.0 / a.y;
  let rb = 0.5 / b.y;
  let disc = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
  var t1 = (b.y - disc) * ra;
  var t2 = (b.y + disc) * ra;
  if (abs(a.y) <= max(abs(b.y), abs(p12.y)) * 1.0e-4) {
    t1 = p12.y * rb;
    t2 = p12.y * rb;
  }
  return vec2<f32>((a.x * t1 - b.x * 2.0) * t1 + p12.x, (a.x * t2 - b.x * 2.0) * t2 + p12.x);
}

fn solveVertPoly(p12: vec4<f32>, p3: vec2<f32>) -> vec2<f32> {
  let a = vec2<f32>(p12.x - p12.z * 2.0 + p3.x, p12.y - p12.w * 2.0 + p3.y);
  let b = vec2<f32>(p12.x - p12.z, p12.y - p12.w);
  let ra = 1.0 / a.x;
  let rb = 0.5 / b.x;
  let disc = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
  var t1 = (b.x - disc) * ra;
  var t2 = (b.x + disc) * ra;
  if (abs(a.x) <= max(abs(b.x), abs(p12.x)) * 1.0e-4) {
    t1 = p12.x * rb;
    t2 = p12.x * rb;
  }
  return vec2<f32>((a.y * t1 - b.y * 2.0) * t1 + p12.y, (a.y * t2 - b.y * 2.0) * t2 + p12.y);
}

fn calcBandLoc(glyphLoc: vec2<i32>, offset: i32) -> vec2<i32> {
  var bandLoc = vec2<i32>(glyphLoc.x + offset, glyphLoc.y);
  bandLoc.y = bandLoc.y + (bandLoc.x >> 12u);
  bandLoc.x = bandLoc.x & 4095;
  return bandLoc;
}

@fragment
fn main(in: FIn) -> @location(0) vec4<f32> {
  // Cull back-facing fragments — text quads behave like one-sided sheets of
  // paper. Without this, the back side of a rotated quad shows geometrically
  // correct mirror-image text. Callers wanting double-sided readable text
  // add a second TextRenderable rotated 180° (or use the doubleSided helper).
  if (!in.frontFacing) {
    discard;
  }
  let renderCoord = in.vTexcoord;
  let emsPerPixel = fwidth(renderCoord);
  let pixelsPerEm = 1.0 / emsPerPixel;

  let glyphLoc = vec2<i32>(i32(in.vGlyph.x + 0.5), i32(in.vGlyph.y + 0.5));
  let bandMax = vec2<i32>(i32(in.vGlyph.z + 0.5), i32(in.vGlyph.w + 0.5));
  let bandTransform = in.vBanding;

  let bandIndex = clamp(
    vec2<i32>(renderCoord * bandTransform.xy + bandTransform.zw),
    vec2<i32>(0, 0),
    bandMax
  );

  var xcov: f32 = 0.0;
  var xwgt: f32 = 0.0;
  let hbandRaw = textureLoad(bandTex, vec2<i32>(glyphLoc.x + bandIndex.y, glyphLoc.y), 0);
  let hbandCount = i32(hbandRaw.x + 0.5);
  let hbandOffset = i32(hbandRaw.y + 0.5);
  let hbandLoc = calcBandLoc(glyphLoc, hbandOffset);
  for (var ci: i32 = 0; ci < hbandCount; ci = ci + 1) {
    let locRaw = textureLoad(bandTex, vec2<i32>(hbandLoc.x + ci, hbandLoc.y), 0);
    let curveLoc = vec2<i32>(i32(locRaw.x + 0.5), i32(locRaw.y + 0.5));
    let p12 = textureLoad(curveTex, curveLoc, 0) - vec4<f32>(renderCoord, renderCoord);
    let p3 = textureLoad(curveTex, vec2<i32>(curveLoc.x + 1, curveLoc.y), 0).xy - renderCoord;
    if (max(max(p12.x, p12.z), p3.x) * pixelsPerEm.x < -0.5) { break; }
    let code = calcRootCode(p12.y, p12.w, p3.y);
    if (code != 0) {
      let r = solveHorizPoly(p12, p3) * pixelsPerEm.x;
      if ((code & 1) != 0) {
        xcov = xcov + clamp(r.x + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
      }
      if (code > 1) {
        xcov = xcov - clamp(r.y + 0.5, 0.0, 1.0);
        xwgt = max(xwgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
      }
    }
  }

  var ycov: f32 = 0.0;
  var ywgt: f32 = 0.0;
  let vbandRaw = textureLoad(bandTex, vec2<i32>(glyphLoc.x + bandMax.y + 1 + bandIndex.x, glyphLoc.y), 0);
  let vbandCount = i32(vbandRaw.x + 0.5);
  let vbandOffset = i32(vbandRaw.y + 0.5);
  let vbandLoc = calcBandLoc(glyphLoc, vbandOffset);
  for (var ci: i32 = 0; ci < vbandCount; ci = ci + 1) {
    let locRaw = textureLoad(bandTex, vec2<i32>(vbandLoc.x + ci, vbandLoc.y), 0);
    let curveLoc = vec2<i32>(i32(locRaw.x + 0.5), i32(locRaw.y + 0.5));
    let p12 = textureLoad(curveTex, curveLoc, 0) - vec4<f32>(renderCoord, renderCoord);
    let p3 = textureLoad(curveTex, vec2<i32>(curveLoc.x + 1, curveLoc.y), 0).xy - renderCoord;
    if (max(max(p12.y, p12.w), p3.y) * pixelsPerEm.y < -0.5) { break; }
    let code = calcRootCode(p12.x, p12.z, p3.x);
    if (code != 0) {
      let r = solveVertPoly(p12, p3) * pixelsPerEm.y;
      if ((code & 1) != 0) {
        ycov = ycov - clamp(r.x + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(r.x) * 2.0, 0.0, 1.0));
      }
      if (code > 1) {
        ycov = ycov + clamp(r.y + 0.5, 0.0, 1.0);
        ywgt = max(ywgt, clamp(1.0 - abs(r.y) * 2.0, 0.0, 1.0));
      }
    }
  }

  var coverage = max(
    abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0),
    min(abs(xcov), abs(ycov))
  );
  coverage = clamp(coverage, 0.0, 1.0);
  // Coverage gamma: raise edge coverage to 1/coverageGamma so anti-aliased edges composite
  // heavier (mimics gamma-space stem darkening). textU.color.x is 1 by default (no-op).
  coverage = pow(coverage, textU.color.x);
  return in.vColor * coverage;
}
