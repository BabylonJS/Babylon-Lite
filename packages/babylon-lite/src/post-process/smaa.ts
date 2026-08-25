// SMAA — Subpixel Morphological Anti-Aliasing, as a frame-graph post-process task.
//
// A three-pass image-space filter (Jimenez et al. 2012):
//   1. edge detection      colour            -> edges    (luma, with local contrast adaptation)
//   2. blending weights    edges             -> weights  (pattern search + coverage reconstruction)
//   3. neighbourhood blend colour + weights  -> anti-aliased colour
//
// Unlike MSAA this works on the FINAL IMAGE, so it smooths any high-contrast edge regardless of
// where it came from — a polygon silhouette, an alpha cutout, a specular highlight, or a straight
// line inside a texture. MSAA only supersamples polygon coverage and cannot touch the last three.
//
// ── Why no AreaTex / SearchTex, decided by measurement ─────────────────────────────────────────
// Reference SMAA ships two precomputed lookup textures — AreaTex (160x560 R8G8, 179,200 bytes) and
// SearchTex (~2 KB). Neither is shipped or generated here, and the reasons are specific rather than
// "to save bytes":
//
//   AreaTex exists because reference SMAA's coverage is an exact area integral over 16 sub-pixel
//   edge patterns, each a separate polygon-clipping case. Evaluated inline that is a 16-way branch,
//   and neighbouring pixels along one edge take different arms, so a warp runs them serially — a
//   cache-coherent fetch is genuinely the cheaper side of that trade. The reconstruction used here
//   (a piecewise-linear edge with one kink at the middle of the run) integrates EXACTLY as a
//   trapezoid plus one zero-crossing split: see smaaAccum below, ~15 ALU ops and one conditional,
//   not a divergent 16-case branch. Measured: switching from a midpoint sample to the exact integral
//   was worth +0.4 percentage points, so the exactness matters a little.
//
//   This is NOT the same function AreaTex stores, and the difference is in the pattern index rather
//   than the integral. Reference SMAA indexes the table on both crossing ends separately, so all 16
//   combinations are distinct. Here each end is reduced to a single signed step (see cl/cr below):
//   a crossing in this row is +1, one in the row above is -1, and "no crossing" and "crossings on
//   both sides" both collapse to 0. The two collapsed cases are genuine information loss — a line
//   that simply ends, and a T-junction, are reconstructed as if flat. Measured against the
//   glsl-smaa oracle on the synthetic suite, what remains is 55.8 dB on staircases and 37.8 dB on
//   crossing thin lines, the latter being exactly where the collapse bites.
//
//   SearchTex exists to jump several pixels per fetch when walking a long edge run. Measured on
//   hard-surface content, sweeping maxSearchSteps from 4 to 64 moved the error by less than 0.2
//   percentage points — the runs terminate almost immediately, so there is no long search to
//   accelerate. It would buy nothing here.
//
// The default maxSearchSteps stays at 16 (reference SMAA's "high" preset) rather than the 4 that
// measured identically, because content with long clean silhouettes — which this measurement did
// not contain — is exactly where a short search would show up.
//
// ── What is and is not implemented ─────────────────────────────────────────────────────────────
// Implemented: luma edge detection with local contrast adaptation, orthogonal (horizontal and
// vertical) pattern search that terminates at perpendicular crossings, exact coverage integration,
// reference-style per-side bilinear neighbourhood blending, and an OPTIONAL simplified diagonal
// path (`diagonalDetection`, off by default — see its doc for the measurements).
//
// NOT implemented:
//   - Corner rounding (reference's SMAA_CORNER_ROUNDING). This is a real quality gap, not a
//     nicety: on axis-aligned corner-heavy content, where the ideal output is the input untouched,
//     canonical SMAA with corner detection scores 0.197 mean abs error against 0.472 here — it is
//     what stops a corner being blended as if it were a step. Measured with lab/lite/smaa-lab.html.
//   - The temporal modes (SMAA T2x/S2x). For temporal supersampling use createTaaPostProcessTask
//     alongside this.
//   - Predication, and the stencil optimisation that skips the weight pass on non-edge pixels.
//
// On diagonals: measured on hard-surface interior content, only ~17-20% of edge energy fell within
// 30-60 degrees, against ~48-58% within 10 degrees of an axis. Diagonal detection is therefore a
// minority win on that kind of scene; content with lots of 45-degree structure would differ.
//
// Add it at the END of a frame-graph chain, after tone mapping: it is a perceptual filter and wants
// the image in the space the viewer sees, not linear HDR.

import type { EngineContext } from "../engine/engine.js";
import type { NormalizedViewport } from "../camera/camera.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import {
    createPostProcessTask,
    type PostProcessAlphaMode,
    type PostProcessSamplingMode,
    type PostProcessTask,
    type PostProcessTaskSettings,
} from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";

/** Configuration for `createSmaaPostProcessTask`. */
export interface SmaaPostProcessTaskConfig extends PostProcessTaskSettings {
    /** Source sampling is fixed per pass and not user-configurable — see `record()`. */
    sourceSamplingMode?: PostProcessSamplingMode;
    /** Luma difference that counts as an edge (default `0.05`). Lower catches more edges and more
     *  noise; measured on hard-surface content, gains are flat from 0.03–0.08 and fall away by 0.15. */
    threshold?: number;
    /** How far the pattern search runs along an edge, in pixels (default `16`, max `112`). Longer
     *  runs reconstruct shallower slopes — a nearly-horizontal line needs a long search — at the cost
     *  of more texture fetches per edge pixel. Non-finite values fall back to the default. */
    maxSearchSteps?: number;
    /** Detect 45-degree patterns as well as horizontal/vertical ones (default `false`).
     *
     *  Reference SMAA enables its diagonal path by default; this one is off because MEASURED on
     *  hard-surface interior content it never beat leaving it off — 4.3% better than no-AA with it
     *  off, against 0.0/1.7/2.5/3.3/3.7% at minimum runs of 2/3/4/6/10, i.e. it only approaches the
     *  off result as it stops firing. See minDiagonalRun for the likely reason. Turn it on for
     *  content with genuine 45-degree structure, and measure. */
    diagonalDetection?: boolean;
    /** Shortest diagonal run, in pixels, that counts as a 45-degree pattern (default `4`).
     *
     *  Raising it makes detection more selective. Note the known weakness of this simplified model:
     *  for a MAIN-diagonal edge the left edges and the matching top edges land on ADJACENT
     *  diagonals, so the diagonal path claims one and the orthogonal path claims the other, and the
     *  same edge gets two different reconstructions. Reference SMAA avoids that by resolving both
     *  through one area lookup. Fixing it here needs the neighbouring diagonal to be suppressed in
     *  step, which is why this is off by default rather than merely tuned. */
    minDiagonalRun?: number;
    /** Set when `sourceTexture` is an sRGB view (e.g. `bgra8unorm-srgb`).
     *
     *  Sampling an sRGB view DECODES to linear, so luma — and therefore the fixed `threshold` —
     *  would be measured in linear space, where dark regions are compressed and far fewer edges
     *  clear the bar. Reference SMAA requires edge detection to read non-sRGB values. With this set,
     *  the edge pass re-encodes each sample before taking luma, so the threshold means the same
     *  thing either way. Only edge DETECTION is affected; neighbourhood blending still works on the
     *  decoded values, which is what it should do. */
    sourceIsSrgb?: boolean;
    /** Blend along the stronger axis only, as canonical SMAA does (default `true`). With it off,
     *  all four neighbours are mixed, which at a corner or a crossing pulls in pixels from around
     *  the corner and rounds it off. */
    dominantAxisBlend?: boolean;
}

/** A Subpixel Morphological Anti-Aliasing post-process task. */
export interface SmaaPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    /** These four are narrowed to non-optional (as `PostProcessTask` does) because `record()`
     *  forwards them to the presenting pass every frame, so mutating them genuinely takes effect. */
    targetTexture: RenderTarget | null;
    viewport: NormalizedViewport | null;
    clear: boolean;
    alphaMode: PostProcessAlphaMode;
    outputTexture: RenderTarget;
    /** Luma difference that counts as an edge. Call `updateUniforms()` after changing it. */
    threshold: number;
    /** How far the pattern search runs along an edge, in pixels. Shallow-angle edges make long
     *  runs, so raising this can matter on hard-surface content. Call `updateUniforms()` after. */
    maxSearchSteps: number;
    /** Whether 45-degree patterns are detected. Call `updateUniforms()` after changing it. */
    diagonalDetection: boolean;
    /** Shortest diagonal run that counts as a 45-degree pattern. Call `updateUniforms()` after. */
    minDiagonalRun: number;
    /** Whether the source texture is an sRGB view. Call `updateUniforms()` after changing it. */
    sourceIsSrgb: boolean;
    /** Whether blending commits to the stronger axis. Call `updateUniforms()` after changing it. */
    dominantAxisBlend: boolean;
    /** Intermediate edge and weight targets, exposed for debugging the filter. */
    readonly edgesTexture: RenderTarget;
    readonly weightsTexture: RenderTarget;
    /** Re-upload the pass uniforms. Required after mutating any of `threshold`, `maxSearchSteps`,
     *  `diagonalDetection`, `minDiagonalRun`, `sourceIsSrgb` or `dominantAxisBlend`. */
    updateUniforms(): void;
    dispose(): void;
}

interface SmaaTaskInternal extends SmaaPostProcessTask {
    _edgeDetect: PostProcessTask;
    _blendWeights: PostProcessTask;
    _neighbourhood: PostProcessTask;
    _edges: RenderTarget;
    _weights: RenderTarget;
}

const EDGE_UNIFORM_WGSL = `struct SmaaEdgeParams{threshold:f32,srgb:f32,pad1:f32,pad2:f32}
@group(0) @binding(2) var<uniform> smaaEdge:SmaaEdgeParams;`;

// Pass 1 — luma edge detection.
//
// An edge is recorded on the LEFT (r) and TOP (g) boundary of each pixel, so every boundary in the
// image is owned by exactly one pixel and is never counted twice.
//
// Local contrast adaptation is what stops a strong edge from dragging its weaker neighbours into
// the pattern search: without it, a bright specular line makes the whole surrounding region look
// like edges and the filter smears texture detail that was never aliased.
const EDGE_FRAGMENT_WGSL = /* wgsl */ `fn smaaLuma(c:vec3f)->f32{return dot(c,vec3f(0.2126,0.7152,0.0722));}
// Sampling an sRGB VIEW decodes to linear, which would move the threshold's meaning into linear
// space and lose most dark-region edges. Re-encode first when the caller says the source is sRGB, so
// edge detection always measures the same gamma-space luma. Only detection does this; the blend pass
// deliberately keeps working on decoded values.
fn smaaEnc(c:f32)->f32{ return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308); }
fn smaaDetectLuma(c:vec3f)->f32{
    if (smaaEdge.srgb > 0.5) {
        return smaaLuma(vec3f(smaaEnc(clamp(c.r, 0.0, 1.0)), smaaEnc(clamp(c.g, 0.0, 1.0)), smaaEnc(clamp(c.b, 0.0, 1.0))));
    }
    return smaaLuma(c);
}
fn smaaFetch(uv:vec2f)->vec4f{return textureSampleLevel(sourceTextureSampler,sourceSampler,uv,0.0);}
fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
    let ts = 1.0 / vec2f(textureDimensions(sourceTextureSampler));
    let l  = smaaDetectLuma(color.rgb);
    let ll = smaaDetectLuma(smaaFetch(uv + vec2f(-ts.x, 0.0)).rgb);
    let lt = smaaDetectLuma(smaaFetch(uv + vec2f(0.0, -ts.y)).rgb);
    let delta = vec2f(abs(l - ll), abs(l - lt));
    var edges = step(vec2f(smaaEdge.threshold), delta);
    if (edges.x + edges.y == 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    let lr  = smaaDetectLuma(smaaFetch(uv + vec2f(ts.x, 0.0)).rgb);
    let lb  = smaaDetectLuma(smaaFetch(uv + vec2f(0.0, ts.y)).rgb);
    let ll2 = smaaDetectLuma(smaaFetch(uv + vec2f(-2.0 * ts.x, 0.0)).rgb);
    let lt2 = smaaDetectLuma(smaaFetch(uv + vec2f(0.0, -2.0 * ts.y)).rgb);
    let d2 = max(max(delta, vec2f(abs(l - lr), abs(l - lb))), vec2f(abs(ll - ll2), abs(lt - lt2)));
    let m = max(d2.x, d2.y);
    // Reference SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR = 2.0.
    edges *= step(vec2f(m), 2.0 * delta);
    return vec4f(edges, 0.0, 1.0);
}`;

const WEIGHT_UNIFORM_WGSL = `struct SmaaWeightParams{maxSearch:f32,diag:f32,pad1:f32,pad2:f32}
@group(0) @binding(2) var<uniform> smaaWeight:SmaaWeightParams;`;

// Pass 2 — blending weights.
//
// For each edge pixel, walk along the edge to both ends of its run, read the CROSSING edge at each
// end to learn which way the silhouette steps there, and reconstruct the coverage the true edge
// would have had.
//
// Coverage is the classic morphological reconstruction: a step at one end of a run of length L pulls
// the edge half a pixel that way, decaying to zero at the middle of the run. The area under that
// line within each pixel is integrated exactly (smaaCoveragePair), including the case where the line
// changes sides inside a single pixel. Reference SMAA reads the same quantity out of AreaTex.
//
// Output channels, and the ownership rule that goes with them. A boundary is OWNED by one pixel
// (its top or left edge) but it blends BOTH pixels beside it, so each channel names which pixel it
// applies to:
//   w.x  this pixel blends UP        w.y  the pixel ABOVE blends DOWN
//   w.z  this pixel blends LEFT      w.w  the pixel to the LEFT blends RIGHT
// The signed coverage `c` says where the reconstructed line sits relative to the owned boundary:
// c > 0 puts it inside this pixel (so this pixel is the one partly covered by the far side), c < 0
// puts it inside the neighbour across the boundary. Exactly one of the pair is ever non-zero.
// Pass 3 therefore has to gather the two boundaries it does NOT own, from the pixels below and
// right — reference SMAA does the same thing when it reads the bottom neighbour's .g and the right
// neighbour's .a.
// The pattern search runs in data-dependent loops and behind branches, so every fetch here uses
// textureSampleLevel: WGSL only permits implicit-derivative sampling (textureSample) in uniform
// control flow, and these are neither uniform nor in need of derivatives.
//
// A run ends at a PERPENDICULAR edge as well as where the parallel one stops. A crossing means the
// silhouette turns there; walking through it merges two separate edges into one over-long run and
// over-blurs the join. Reference SMAA does the same via the `e.r == 0.0` term in its
// SMAASearchXLeft loop condition. The crossing that separates two horizontally adjacent pixels is
// the LEFT edge of the right-hand one, so walking right it belongs to the pixel being entered and
// walking left to the pixel being left behind — which the previous iteration already fetched, so
// carrying it in `behind` keeps this at one fetch per step. Measured against the glsl-smaa oracle,
// adding this took crossing thin lines from 31.5 dB to 36.4 dB (worst-case pixel error 152 -> 40)
// and left clean staircases untouched, which is exactly the expected signature.
const WEIGHT_FRAGMENT_WGSL = /* wgsl */ `
fn smaaEdgeAt(uv:vec2f)->vec2f{return textureSampleLevel(sourceTextureSampler,sourceSampler,uv,0.0).rg;}

// ── Diagonal patterns ──────────────────────────────────────────────────────────────────────────
// A 45-degree boundary is the one case the orthogonal search reads badly: its horizontal runs are a
// single pixel long, so the triangle model yields about 0.125 coverage where the true answer is 0.5.
// The two orientations have distinct signatures in the edge texture (e.r = left edge, e.g = top
// edge, screen y downward):
//
//   ANTI-DIAGONAL, region boundary x+y = c: both the left AND top edge land on the SAME pixel, and
//     those pixels line up along (+1,-1).
//   MAIN DIAGONAL, boundary x-y = c: left edges land on x-y = c and the matching top edges on the
//     NEIGHBOURING diagonal, so the tell is a run of left edges along (+1,+1).
//
// A plain vertical edge also carries left edges, but they line up along (0,1), so walking (1,1)
// terminates immediately — the run length is what separates the two. The minimum accepted run comes
// in as a uniform (smaaWeight.diag, 0 = detection off) because it is the knob that decides how
// often this fires on edges that are merely NEAR 45 degrees, where a flat half-coverage over-blurs.

fn smaaBothEdges(uv:vec2f)->bool{ let e = smaaEdgeAt(uv); return e.x > 0.5 && e.y > 0.5; }

fn smaaDiagRunBoth(uv:vec2f, ts:vec2f, dir:vec2f, maxSteps:f32)->f32{
    var d = 0.0;
    loop {
        if (d >= maxSteps) { break; }
        if (!smaaBothEdges(uv + ts * dir * (d + 1.0))) { break; }
        d = d + 1.0;
    }
    return d;
}
fn smaaDiagRunLeft(uv:vec2f, ts:vec2f, dir:vec2f, maxSteps:f32)->f32{
    var d = 0.0;
    loop {
        if (d >= maxSteps) { break; }
        if (smaaEdgeAt(uv + ts * dir * (d + 1.0)).x <= 0.5) { break; }
        d = d + 1.0;
    }
    return d;
}

// Distance to the end of a run of TOP edges, walking in "dir" (-1 left / +1 right).
// The run also ends at a perpendicular LEFT edge — see the note above this constant.
fn smaaSearchX(uv:vec2f, ts:vec2f, dir:f32, maxSteps:f32, selfLeft:f32)->f32{
    var d = 0.0;
    var behind = selfLeft;
    loop {
        if (d >= maxSteps) { break; }
        if (dir < 0.0 && behind > 0.5) { break; }
        let s = smaaEdgeAt(uv + vec2f(ts.x * dir * (d + 1.0), 0.0));
        if (dir > 0.0 && s.x > 0.5) { break; }
        if (s.y < 0.5) { break; }
        behind = s.x;
        d = d + 1.0;
    }
    return d;
}
// Distance to the end of a run of LEFT edges, walking in "dir" (-1 up / +1 down). The perpendicular
// that closes the run is the TOP edge, mirroring smaaSearchX.
fn smaaSearchY(uv:vec2f, ts:vec2f, dir:f32, maxSteps:f32, selfTop:f32)->f32{
    var d = 0.0;
    var behind = selfTop;
    loop {
        if (d >= maxSteps) { break; }
        if (dir < 0.0 && behind > 0.5) { break; }
        let s = smaaEdgeAt(uv + vec2f(0.0, ts.y * dir * (d + 1.0)));
        if (dir > 0.0 && s.y > 0.5) { break; }
        if (s.x < 0.5) { break; }
        behind = s.y;
        d = d + 1.0;
    }
    return d;
}

// Signed height of the reconstructed edge at position "x" along a run of length "len", measured from
// the owned boundary. Positive = the line lies inside THIS pixel; negative = inside the neighbour
// across the boundary. A step at an end pulls the line half a pixel that way, decaying to zero at
// the middle of the run.
fn smaaHeight(x:f32, len:f32, cNear:f32, cFar:f32)->f32{
    let h = max(len * 0.5, 1e-4);
    if (x < h) {
        return cNear * 0.5 * max(0.0, 1.0 - x / h);
    }
    return cFar * 0.5 * max(0.0, 1.0 - (len - x) / h);
}

// Exact integral of a LINEAR segment of that height over [p,q]: positive part into .x, magnitude of
// the negative part into .y. When the segment changes sign inside the interval it is split at the
// crossing into two triangles — the case reference SMAA's area() also singles out, and the one a
// midpoint sample gets most wrong.
fn smaaAccum(p:f32, q:f32, hp:f32, hq:f32)->vec2f{
    if (q <= p) { return vec2f(0.0); }
    let w = q - p;
    if (hp * hq >= 0.0) {
        let a = 0.5 * (hp + hq) * w;
        return vec2f(max(a, 0.0), max(-a, 0.0));
    }
    let t = hp / (hp - hq);
    let a1 = 0.5 * hp * (w * t);
    let a2 = 0.5 * hq * (w * (1.0 - t));
    return vec2f(max(a1, 0.0) + max(a2, 0.0), max(-a1, 0.0) + max(-a2, 0.0));
}

// Coverage of the pixel spanning [x0, x0+1]: the exact area under the reconstructed edge, split at
// the kink in the middle of the run so each piece is linear.
fn smaaCoveragePair(x0:f32, len:f32, cNear:f32, cFar:f32)->vec2f{
    let x1 = x0 + 1.0;
    let m = clamp(len * 0.5, x0, x1);
    let h0 = smaaHeight(x0, len, cNear, cFar);
    let hm = smaaHeight(m,  len, cNear, cFar);
    let h1 = smaaHeight(x1, len, cNear, cFar);
    return smaaAccum(x0, m, h0, hm) + smaaAccum(m, x1, hm, h1);
}

fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
    let ts = 1.0 / vec2f(textureDimensions(sourceTextureSampler));
    let e = color.rg;
    var w = vec4f(0.0);
    let maxSteps = smaaWeight.maxSearch;

    // Diagonals take priority over the orthogonal patterns (as in reference SMAA): where a 45-degree
    // run is found, the orthogonal search would fight it with a badly under-estimated coverage.
    var diagonal = false;
    if (smaaWeight.diag > 0.5) {
        let minRun = smaaWeight.diag;
        if (e.x > 0.5 && e.y > 0.5) {
            let a = smaaDiagRunBoth(uv, ts, vec2f(-1.0,  1.0), maxSteps);
            let b = smaaDiagRunBoth(uv, ts, vec2f( 1.0, -1.0), maxSteps);
            if (a + b + 1.0 >= minRun) {
                // Half-covered by the region across the boundary. Its left and top neighbours both
                // lie on that side, so blending up and blending left are equivalent here.
                w.x = 0.5;
                diagonal = true;
            }
        }
        if (!diagonal && e.x > 0.5) {
            let a = smaaDiagRunLeft(uv, ts, vec2f(-1.0, -1.0), maxSteps);
            let b = smaaDiagRunLeft(uv, ts, vec2f( 1.0,  1.0), maxSteps);
            if (a + b + 1.0 >= minRun) {
                w.z = 0.5;
                diagonal = true;
            }
        }
    }

    if (!diagonal && e.y > 0.5) {         // horizontal edge along this pixel's top
        let d1 = smaaSearchX(uv, ts, -1.0, maxSteps, e.x);
        let d2 = smaaSearchX(uv, ts,  1.0, maxSteps, e.x);
        let len = d1 + d2 + 1.0;
        // The crossing (vertical) edge just past each end says which way the silhouette steps. A
        // crossing in THIS row means the bright side continues above, so blend up; one in the row
        // above means it steps the other way. (Derived from a descending staircase and checked
        // against its mirror — getting this backwards makes the filter sharpen instead of smooth.)
        let lEnd = uv + vec2f(-ts.x * d1, 0.0);
        let rEnd = uv + vec2f( ts.x * (d2 + 1.0), 0.0);
        let cl = step(0.5, smaaEdgeAt(lEnd).x) - step(0.5, smaaEdgeAt(lEnd + vec2f(0.0, -ts.y)).x);
        let cr = step(0.5, smaaEdgeAt(rEnd).x) - step(0.5, smaaEdgeAt(rEnd + vec2f(0.0, -ts.y)).x);
        let c = smaaCoveragePair(d1, len, cl, cr);
        w.x = c.x;
        w.y = c.y;
    }
    if (!diagonal && e.x > 0.5) {         // vertical edge along this pixel's left
        let d1 = smaaSearchY(uv, ts, -1.0, maxSteps, e.y);
        let d2 = smaaSearchY(uv, ts,  1.0, maxSteps, e.y);
        let len = d1 + d2 + 1.0;
        let tEnd = uv + vec2f(0.0, -ts.y * d1);
        let bEnd = uv + vec2f(0.0,  ts.y * (d2 + 1.0));
        let ct = step(0.5, smaaEdgeAt(tEnd).y) - step(0.5, smaaEdgeAt(tEnd + vec2f(-ts.x, 0.0)).y);
        let cb = step(0.5, smaaEdgeAt(bEnd).y) - step(0.5, smaaEdgeAt(bEnd + vec2f(-ts.x, 0.0)).y);
        let c = smaaCoveragePair(d1, len, ct, cb);
        w.z = c.x;
        w.w = c.y;
    }
    return w;
}`;

const NEIGHBOURHOOD_TEXTURE_WGSL = `@group(0) @binding(2) var smaaWeights:texture_2d<f32>;`;
const NEIGHBOURHOOD_UNIFORM_WGSL = `struct SmaaBlendParams{dominant:f32,p0:f32,p1:f32,p2:f32}
@group(0) @binding(3) var<uniform> smaaBlend:SmaaBlendParams;`;

// Pass 3 — neighbourhood blending.
//
// Gathers the four boundaries around this pixel: the two it owns (its own top and left edges) and
// the two owned by the pixels below and to the right. Without the latter two a pixel is never
// blended across its bottom or right boundary, which silently drops half of the reconstruction.
// The centre keeps whatever weight is left over, so a pixel with no edge nearby is returned
// bit-for-bit unchanged and flat regions cost nothing.
//
// Reference SMAA takes ONE bilinear tap per side, at a fractional offset equal to that side's
// weight, then mixes the taps by their normalised weights. Each tap therefore still carries
// (1 - w) of the CENTRE pixel: with two opposing sides at 0.5 the result keeps half the centre,
// a quarter of each neighbour. Accumulating the neighbours directly instead — the obvious reading
// of "blend by the weights" — drops the centre entirely once the weights reach 1, which visibly
// over-blurs thin features and 1px lines that carry edges on both sides. Single-sided edges, the
// overwhelmingly common case, are identical either way, which is why this hid for so long.
//
// The whole vec4 is blended, alpha included: taking RGB from the neighbours but alpha from the
// centre desynchronises the two, breaking premultiplied-alpha invariants and fringing cut-outs.
const NEIGHBOURHOOD_FRAGMENT_WGSL = /* wgsl */ `
fn smaaFetch(uv:vec2f)->vec4f{return textureSampleLevel(sourceTextureSampler,sourceSampler,uv,0.0);}
fn smaaWeightAt(uv:vec2f)->vec4f{return textureSampleLevel(smaaWeights,sourceSampler,uv,0.0);}
fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
    let ts = 1.0 / vec2f(textureDimensions(sourceTextureSampler));
    let wSelf  = smaaWeightAt(uv);
    let wBelow = smaaWeightAt(uv + vec2f(0.0,  ts.y));
    let wRight = smaaWeightAt(uv + vec2f( ts.x, 0.0));
    let up    = wSelf.x;    // my top boundary, line inside me
    let down  = wBelow.y;   // the boundary below me, line inside me
    let left  = wSelf.z;    // my left boundary, line inside me
    let right = wRight.w;   // the boundary right of me, line inside me
    if (up + down + left + right < 1e-4) { return color; }
    // Canonical SMAA commits to ONE axis: where a horizontal and a vertical edge meet, blending
    // along both pulls in pixels from around the corner and rounds it off. Keep only the stronger.
    var bUp = up; var bDown = down; var bLeft = left; var bRight = right;
    if (smaaBlend.dominant > 0.5) {
        if (max(left, right) > max(up, down)) {
            bUp = 0.0;
            bDown = 0.0;
        } else {
            bLeft = 0.0;
            bRight = 0.0;
        }
    }
    let sum = bUp + bDown + bLeft + bRight;
    if (sum < 1e-4) { return color; }
    // One tap per side, each still carrying (1 - w) of the centre; see the note above this constant.
    var acc = vec4f(0.0);
    acc += (bUp    / sum) * mix(color, smaaFetch(uv + vec2f(0.0, -ts.y)), clamp(bUp,    0.0, 1.0));
    acc += (bDown  / sum) * mix(color, smaaFetch(uv + vec2f(0.0,  ts.y)), clamp(bDown,  0.0, 1.0));
    acc += (bLeft  / sum) * mix(color, smaaFetch(uv + vec2f(-ts.x, 0.0)), clamp(bLeft,  0.0, 1.0));
    acc += (bRight / sum) * mix(color, smaaFetch(uv + vec2f( ts.x, 0.0)), clamp(bRight, 0.0, 1.0));
    return acc;
}`;

/** Resize a persistently-allocated intermediate target to match the source. */
function ensureTarget(rt: RenderTarget, engine: EngineContext, width: number, height: number): void {
    if (rt._eager && rt._width === width && rt._height === height) {
        return;
    }
    rt._eager = false;
    disposeRenderTarget(rt);
    rt._descriptor.size = { width, height };
    buildRenderTarget(rt, engine);
    rt._eager = true;
}

/** Hard ceiling on the pattern search, matching reference SMAA's maximum. The shader's loops
 *  terminate against this value, so a non-finite or absurd one is not merely a bad setting: with
 *  clamp-to-edge sampling an edge texel at the border repeats forever, and the loop never exits. */
const MAX_SEARCH_STEPS = 112;

/** Coerce a search length to a finite, in-range integer. */
function clampSearchSteps(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(MAX_SEARCH_STEPS, Math.max(1, Math.floor(value)));
}

/** Shortest run the diagonal path will accept. Two is the floor: a single diagonal pixel is a dot,
 *  not a 45-degree run, and claiming it produces an isolated blur. */
const MIN_DIAGONAL_RUN = 2;

/** Coerce a diagonal run length. Separate from clampSearchSteps only for the higher floor — the
 *  constructor and the setter must agree, or a task can start in a state its own setter rejects. */
function clampDiagonalRun(value: number | undefined, fallback: number): number {
    return Math.max(MIN_DIAGONAL_RUN, clampSearchSteps(value, fallback));
}

/** Coerce the edge threshold. A non-finite or negative value would make every pixel an edge (the
 *  comparison is against a luma DIFFERENCE, which is never negative), turning the filter into a
 *  full-screen blur; zero does the same. Reference SMAA's usable range tops out around 0.5. */
function clampThreshold(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.min(0.5, value);
}

/**
 * Create an SMAA (Subpixel Morphological Anti-Aliasing) post-process task.
 *
 * @param config - Source/target textures plus the edge threshold and search length.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The SMAA task. Add it at the end of the frame-graph chain, after tone mapping.
 */
export function createSmaaPostProcessTask(config: SmaaPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): SmaaPostProcessTask {
    const name = config.name ?? "smaa";
    const source = config.sourceTexture;
    const params = {
        threshold: clampThreshold(config.threshold, 0.05),
        sourceIsSrgb: config.sourceIsSrgb ?? false,
        dominantAxisBlend: config.dominantAxisBlend ?? true,
        maxSearchSteps: clampSearchSteps(config.maxSearchSteps, 16),
        diagonalDetection: config.diagonalDetection ?? false,
        minDiagonalRun: clampDiagonalRun(config.minDiagonalRun, 4),
    };

    // Edges hold two binary channels and weights four coverages in [0,1]: 8-bit is ample for both,
    // and keeping them narrow keeps the bandwidth cost of the extra passes down.
    const edges = createRenderTarget({ lbl: `${name}-edges`, format: "rgba8unorm", samples: 1, size: { width: 1, height: 1 } });
    const weights = createRenderTarget({ lbl: `${name}-weights`, format: "rgba8unorm", samples: 1, size: { width: 1, height: 1 } });

    const edgeDetect = createPostProcessTask(
        {
            name: `${name}-edges`,
            sourceTexture: source,
            targetTexture: edges,
            sourceSamplingMode: "linear",
            _shader: {
                fragmentWGSL: EDGE_FRAGMENT_WGSL,
                uniformWGSL: EDGE_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = params.threshold;
                    data[1] = params.sourceIsSrgb ? 1 : 0;
                },
            },
        },
        engine,
        scene
    );
    const blendWeights = createPostProcessTask(
        {
            name: `${name}-weights`,
            sourceTexture: edges,
            targetTexture: weights,
            // The pattern search reads exact texels; bilinear would bleed an edge into its
            // neighbours and make the measured run lengths come out wrong.
            sourceSamplingMode: "nearest",
            _shader: {
                fragmentWGSL: WEIGHT_FRAGMENT_WGSL,
                uniformWGSL: WEIGHT_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = params.maxSearchSteps;
                    data[1] = params.diagonalDetection ? params.minDiagonalRun : 0;
                },
            },
        },
        engine,
        scene
    );
    const neighbourhood = createPostProcessTask(
        {
            name: `${name}-blend`,
            sourceTexture: source,
            targetTexture: config.targetTexture,
            sourceSamplingMode: "linear",
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                fragmentWGSL: NEIGHBOURHOOD_FRAGMENT_WGSL,
                extraTextureWGSL: NEIGHBOURHOOD_TEXTURE_WGSL,
                extraTextures: [weights],
                uniformWGSL: NEIGHBOURHOOD_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = params.dominantAxisBlend ? 1 : 0;
                },
            },
        },
        engine,
        scene
    );

    const task: SmaaTaskInternal = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        sourceSamplingMode: config.sourceSamplingMode ?? "linear",
        targetTexture: config.targetTexture ?? null,
        alphaMode: config.alphaMode ?? 0,
        viewport: config.viewport ?? null,
        clear: config.clear ?? true,
        outputTexture: neighbourhood.outputTexture,
        edgesTexture: edges,
        weightsTexture: weights,
        get threshold(): number {
            return params.threshold;
        },
        set threshold(value: number) {
            params.threshold = clampThreshold(value, params.threshold);
        },
        get maxSearchSteps(): number {
            return params.maxSearchSteps;
        },
        set maxSearchSteps(value: number) {
            params.maxSearchSteps = clampSearchSteps(value, params.maxSearchSteps);
        },
        get diagonalDetection(): boolean {
            return params.diagonalDetection;
        },
        set diagonalDetection(value: boolean) {
            params.diagonalDetection = value;
        },
        get minDiagonalRun(): number {
            return params.minDiagonalRun;
        },
        set minDiagonalRun(value: number) {
            params.minDiagonalRun = clampDiagonalRun(value, params.minDiagonalRun);
        },
        get sourceIsSrgb(): boolean {
            return params.sourceIsSrgb;
        },
        set sourceIsSrgb(value: boolean) {
            params.sourceIsSrgb = value;
        },
        get dominantAxisBlend(): boolean {
            return params.dominantAxisBlend;
        },
        set dominantAxisBlend(value: boolean) {
            params.dominantAxisBlend = value;
        },
        _edgeDetect: edgeDetect,
        _blendWeights: blendWeights,
        _neighbourhood: neighbourhood,
        _edges: edges,
        _weights: weights,
        record(): void {
            // Push the facade's current settings onto the passes that own them, so mutating
            // `task.sourceTexture` / `targetTexture` / `viewport` / `clear` / `alphaMode` after
            // construction actually takes effect. Without this the sub-tasks keep the values they
            // captured at creation and the public fields are decoration.
            //
            // sourceSamplingMode is deliberately NOT forwarded: the passes have fixed, non-negotiable
            // requirements — the weight pass must read exact texels (bilinear would bleed an edge
            // into its neighbours and corrupt run lengths) while the other two want linear.
            edgeDetect.sourceTexture = task.sourceTexture;
            neighbourhood.sourceTexture = task.sourceTexture;
            neighbourhood.targetTexture = task.targetTexture;
            neighbourhood.viewport = task.viewport;
            neighbourhood.clear = task.clear;
            neighbourhood.alphaMode = task.alphaMode;

            const src = task.sourceTexture;
            const w = src._width > 0 ? src._width : 1;
            const h = src._height > 0 ? src._height : 1;
            ensureTarget(edges, engine, w, h);
            ensureTarget(weights, engine, w, h);
            edgeDetect.record();
            blendWeights.record();
            neighbourhood.record();
            task.outputTexture = neighbourhood.outputTexture;
        },
        execute(): number {
            return (edgeDetect.execute?.() ?? 0) + (blendWeights.execute?.() ?? 0) + (neighbourhood.execute?.() ?? 0);
        },
        updateUniforms(): void {
            edgeDetect.updateUniforms();
            blendWeights.updateUniforms();
            neighbourhood.updateUniforms();
        },
        dispose(): void {
            edgeDetect.dispose();
            blendWeights.dispose();
            neighbourhood.dispose();
            // ensureTarget marks these _eager so the sub-tasks' own buildRenderTarget calls no-op on
            // them; disposeRenderTarget honours that same flag and would skip them, leaking a
            // canvas-sized texture per disposed task. Clear it first (as taa.ts does).
            edges._eager = false;
            weights._eager = false;
            disposeRenderTarget(edges);
            disposeRenderTarget(weights);
        },
    };
    return task;
}
