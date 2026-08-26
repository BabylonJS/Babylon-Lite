// Vector fill renderer — stencil-then-cover, packaged as a LayerRenderer for shape layers.
//
// For each compound path, per frame:
//   1. STENCIL pass — draw a triangle fan (contour center → polyline edge) writing the
//      nonzero winding number into the stencil buffer with no triangulation, so concave /
//      self-intersecting / holey shapes (glyph counters) fill correctly.
//   2. COVER pass  — draw the path's bounding quad where stencil != 0, evaluating the
//      solid / linear / radial gradient in the fragment shader, and reset stencil to 0 so
//      the next path starts clean.
//
// STROKES share this renderer. A stroke is expanded (stroke-geometry.ts) into self-overlapping
// segment quads + round-join fans; those are stencilled as a winding-INDEPENDENT union
// (increment-clamp, no culling) and covered once, so a semi-transparent stroke paints at a
// single uniform alpha instead of accumulating where the expanded triangles overlap.
//
// NONZERO WINDING WITHOUT TWO-SIDED STENCIL. A two-sided implementation uses one draw with
// front faces increment-wrap and back faces decrement-wrap. lite-gl's
// setStencilState is single-sided (gl.stencilOp, not stencilOpSeparate), so we emulate the
// two-sidedness with the classic cull-twice technique: enable face culling and draw the fan
// twice — once culling back faces with INCR_WRAP, once culling front faces with DECR_WRAP.
// The shader's Y-flip affects both passes identically, and the cover test is the sign-agnostic
// `!= 0`, so winding direction does not affect fill coverage.
//
// Rendering targets the default framebuffer (MSAA + stencil via context creation), so this
// renderer only issues imperative draws — there is no render pass object.

import {
    type GLEngineContext,
    type GLIndexBuffer,
    type GLVertexBuffer,
    GLBlendMode,
    bindAttributes,
    createEffect,
    createIndexBuffer,
    createVertexBuffer,
    disposeBuffer,
    disposeEffect,
    drawIndexed,
    isEffectReady,
    setBlendMode,
    setColorMask,
    setCullState,
    setEffectFloat,
    setEffectFloat2,
    setEffectFloat4,
    setEffectFloatArray,
    setEffectFloatArray4,
    setEffectInt,
    setStencilState,
    updateVertexBuffer,
    useEffect,
} from "@babylonjs/lite-gl";
import type { LayerRenderContext, LayerRenderer } from "./layer-renderer.js";
import type { Contour, DrawOp, ParsedLayer, ParsedMask, Transform } from "../animation/parse.js";
import type { Prop, ShapeData } from "../animation/lottie-raw.js";
import { apply, lottieTransform, multiply, type Mat2D } from "../animation/matrix.js";
import { sampleEllipse, sampleMulti, sampleRect, sampleScalar, sampleShape } from "../animation/sample.js";
import { buildContourPoints } from "../animation/geometry.js";
import { buildStrokePoints } from "./stroke-geometry.js";

const GS = 16; // Max gradient stops
const WINDING_MASK = 0x3f;
const MATTE_BIT = 0x40;
const MASK_BIT = 0x80;

const STENCIL_VERT = `#version 300 es
in vec2 position;
uniform vec2 uScreen;
void main() {
  gl_Position = vec4(position.x / uScreen.x * 2.0 - 1.0, 1.0 - position.y / uScreen.y * 2.0, 0.0, 1.0);
}`;

const STENCIL_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`;

const COVER_VERT = `#version 300 es
in vec2 position;
uniform vec2 uScreen;
out vec2 vScr;
void main() {
  vScr = position;
  gl_Position = vec4(position.x / uScreen.x * 2.0 - 1.0, 1.0 - position.y / uScreen.y * 2.0, 0.0, 1.0);
}`;

const COVER_FRAG = `#version 300 es
precision highp float;
in vec2 vScr;
out vec4 fragColor;
uniform int uKind;        // 0 solid, 1 linear, 2 radial
uniform float uAlpha;
uniform vec4 uSolid;
uniform vec4 uGrad;       // start.xy, end.xy (screen space)
uniform int uStopCount;
uniform float uOffsets[${GS}];
uniform vec4 uColors[${GS}];
vec4 ramp(float t) {
  int n = uStopCount;
  if (t <= uOffsets[0]) { return uColors[0]; }
  for (int i = 0; i + 1 < n; i++) {
    float a = uOffsets[i];
    float b = uOffsets[i + 1];
    if (t >= a && t <= b) {
      float f = (t - a) / max(b - a, 1e-6);
      return mix(uColors[i], uColors[i + 1], f);
    }
  }
  return uColors[n - 1];
}
void main() {
  vec4 rgba;
  if (uKind == 0) {
    rgba = uSolid;
  } else {
    vec2 s = uGrad.xy;
    vec2 e = uGrad.zw;
    float t;
    if (uKind == 1) {
      vec2 d = e - s;
      t = clamp(dot(vScr - s, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
    } else {
      t = clamp(length(vScr - s) / max(length(e - s), 1e-6), 0.0, 1.0);
    }
    rgba = ramp(t);
  }
  float a = rgba.a * uAlpha;
  fragColor = vec4(rgba.rgb * a, a);
}`;

interface FillDraw {
    /** Stroke draws stencil a winding-independent union; fills use nonzero winding (cull-twice). */
    stroke: boolean;
    fanFirst: number;
    fanCount: number;
    coverFirst: number;
    coverCount: number;
    paintIndex: number;
}

function samplePoint(prop: Prop | undefined, frame: number, dx: number, dy: number, out: number[]): void {
    out[0] = dx;
    out[1] = dy;
    sampleMulti(prop, frame, out);
}

function transformMatrix(t: Transform, frame: number, a: number[], p: number[], s: number[]): Mat2D {
    samplePoint(t.a, frame, 0, 0, a);
    samplePoint(t.p, frame, 0, 0, p);
    samplePoint(t.s, frame, 100, 100, s);
    const rot = sampleScalar(t.r, frame, 0);
    return lottieTransform(a, p, s, rot);
}

/** Sample a contour's source (bezier path, rect, or ellipse) into a `ShapeData`, or null. */
function sampleContour(contour: Contour, frame: number): ShapeData | null {
    return contour.rect ? sampleRect(contour.rect, frame) : contour.ellipse ? sampleEllipse(contour.ellipse, frame) : contour.path ? sampleShape(contour.path, frame) : null;
}

/** Push the 6-vertex cover quad (the 1px-inflated bounds rect) that drives the cover / mask-resolve
 *  / teardown stencil passes. */
function pushCoverQuad(verts: number[], minx: number, miny: number, maxx: number, maxy: number): void {
    verts.push(minx - 1, miny - 1, maxx + 1, miny - 1, minx - 1, maxy + 1, minx - 1, maxy + 1, maxx + 1, miny - 1, maxx + 1, maxy + 1);
}

/** Append one contour's winding fan (contour center → each polyline edge) to `verts`, expanding the
 *  running union bounds `[minx, miny, maxx, maxy]`. Returns the fan's vertex count. */
function emitWindingFan(pts: number[], np: number, verts: number[], bounds: number[]): number {
    let cMinx = Infinity;
    let cMiny = Infinity;
    let cMaxx = -Infinity;
    let cMaxy = -Infinity;
    for (let k = 0; k < np; k++) {
        const x = pts[k * 2];
        const y = pts[k * 2 + 1];
        if (x < cMinx) {
            cMinx = x;
        }
        if (y < cMiny) {
            cMiny = y;
        }
        if (x > cMaxx) {
            cMaxx = x;
        }
        if (y > cMaxy) {
            cMaxy = y;
        }
    }
    const cx = (cMinx + cMaxx) * 0.5;
    const cy = (cMiny + cMaxy) * 0.5;
    for (let k = 0; k < np - 1; k++) {
        verts.push(cx, cy, pts[k * 2], pts[k * 2 + 1], pts[(k + 1) * 2], pts[(k + 1) * 2 + 1]);
    }
    if (cMinx < bounds[0]) {
        bounds[0] = cMinx;
    }
    if (cMiny < bounds[1]) {
        bounds[1] = cMiny;
    }
    if (cMaxx > bounds[2]) {
        bounds[2] = cMaxx;
    }
    if (cMaxy > bounds[3]) {
        bounds[3] = cMaxy;
    }
    return (np - 1) * 3;
}

/** Create the vector (shape-layer) renderer. Renders fills (solid / linear / radial gradient)
 *  and strokes (solid color). */
export function createFillRenderer(engine: GLEngineContext): LayerRenderer {
    const gl = engine.gl;
    const stencilEffect = createEffect(engine, {
        name: "lottie-vector-stencil",
        vertexSource: STENCIL_VERT,
        fragmentSource: STENCIL_FRAG,
        uniformNames: ["uScreen"],
        samplerNames: [],
        attributeNames: ["position"],
    });
    const coverEffect = createEffect(engine, {
        name: "lottie-vector-cover",
        vertexSource: COVER_VERT,
        fragmentSource: COVER_FRAG,
        uniformNames: ["uScreen", "uKind", "uAlpha", "uSolid", "uGrad", "uStopCount", "uOffsets", "uColors"],
        samplerNames: [],
        attributeNames: ["position"],
    });

    // Per-frame accumulation + scratch (reused across frames to avoid GC churn).
    const verts: number[] = [];
    const draws: FillDraw[] = [];
    const ranges: number[] = []; // token -> (drawStart, drawCount) pairs
    const pts: number[] = [];
    const a = [0, 0];
    const p = [0, 0];
    const s = [100, 100];
    const g0 = [0, 0, 0, 1];
    const g1 = [0, 0];
    const gs: number[] = [];

    // Flat per-draw paint store (indexed by FillDraw.paintIndex).
    const pKind: number[] = [];
    const pAlpha: number[] = [];
    const pSolid: number[] = []; // 4 per draw
    const pGrad: number[] = []; // 4 per draw
    const pStopCount: number[] = [];
    const pOff: number[] = []; // MAX_GRADIENT_STOPS per draw
    const pCol: number[] = []; // MAX_GRADIENT_STOPS * 4 per draw

    // Uniform upload scratch (avoid per-draw allocation).
    const offScratch = new Float32Array(GS);
    const colScratch = new Float32Array(GS * 4);

    // Per-token mask geometry (parallel to `ranges`, indexed by token). maskHas gates the masked
    // render path; the fan is the mask path's winding triangles and the bbox quad drives the
    // resolve + teardown stencil passes.
    const maskHas: boolean[] = [];
    const maskFanFirst: number[] = [];
    const maskFanCount: number[] = [];
    const maskBboxFirst: number[] = [];

    let vbo: GLVertexBuffer | null = null;
    let vertData = new Float32Array(0);
    let vertCapacity = 0; // in floats
    let seqIb: GLIndexBuffer | null = null;
    let seqCapacity = 0; // in indices

    // Scratch union bounds [minx, miny, maxx, maxy] for the current emit, reset at each emit's start.
    const bnds = [0, 0, 0, 0];

    function writePaintBlock(op: DrawOp, m: Mat2D, frame: number, alpha: number): number {
        const idx = pKind.length;
        const paint = op.paint;
        if (paint.kind === "solid" || paint.kind === "stroke") {
            // Both paint as a uniform solid color (kind 0); a stroke differs only in its geometry.
            pKind.push(0);
            pAlpha.push(alpha);
            g0[0] = 0;
            g0[1] = 0;
            g0[2] = 0;
            g0[3] = 1;
            sampleMulti(paint.color, frame, g0);
            pSolid.push(g0[0], g0[1], g0[2], g0[3]);
            pGrad.push(0, 0, 0, 0);
            pStopCount.push(0);
            for (let i = 0; i < GS; i++) {
                pOff.push(0);
            }
            for (let i = 0; i < GS * 4; i++) {
                pCol.push(0);
            }
            return idx;
        }
        // Linear / radial gradient.
        pKind.push(paint.kind === "radial" ? 2 : 1);
        pAlpha.push(alpha);
        pSolid.push(0, 0, 0, 0);
        samplePoint(paint.start, frame, 0, 0, g0);
        samplePoint(paint.end, frame, 0, 0, g1);
        const start: [number, number] = [0, 0];
        const end: [number, number] = [0, 0];
        apply(m, g0[0], g0[1], start);
        apply(m, g1[0], g1[1], end);
        pGrad.push(start[0], start[1], end[0], end[1]);
        const sourceStopCount = paint.stops.count;
        gs.length = 0;
        const raw = sampleMulti(paint.stops.data, frame, gs);
        const stopCount = Math.min(sourceStopCount, GS);
        const alphaStart = sourceStopCount * 4;
        const alphaCount = Math.floor((raw.length - alphaStart) / 2);
        pStopCount.push(stopCount);
        for (let i = 0; i < GS; i++) {
            const sourceIndex = sourceStopCount > GS && i < stopCount ? Math.round((i * (sourceStopCount - 1)) / (stopCount - 1)) : i;
            pOff.push(i < stopCount ? raw[sourceIndex * 4] : 0);
        }
        for (let i = 0; i < GS; i++) {
            if (i < stopCount) {
                const sourceIndex = sourceStopCount > GS ? Math.round((i * (sourceStopCount - 1)) / (stopCount - 1)) : i;
                const offset = sourceIndex * 4;
                pCol.push(raw[offset + 1], raw[offset + 2], raw[offset + 3], sourceIndex < alphaCount ? raw[alphaStart + sourceIndex * 2 + 1] : 1);
            } else {
                pCol.push(0, 0, 0, 0);
            }
        }
        return idx;
    }

    function emitOp(op: DrawOp, worldLayer: Mat2D, frame: number, layerAlpha: number): void {
        let m = worldLayer;
        let groupOpacity = 1;
        for (const transform of op.transforms) {
            m = multiply(m, transformMatrix(transform, frame, a, p, s));
            groupOpacity *= sampleScalar(transform.o, frame, 100) / 100;
        }
        const paintOpacity = sampleScalar(op.paintOpacity, frame, 100) / 100;
        const alpha = layerAlpha * groupOpacity * paintOpacity;
        if (alpha <= 0.0001) {
            return;
        }

        if (op.paint.kind === "stroke") {
            emitStroke(op, m, frame, alpha);
            return;
        }

        // Fill: stencil ALL contours of the compound path together so opposite-winding
        // counters (glyph holes) cancel in the overlap region (nonzero winding), then cover once.
        const fanFirst = verts.length / 2;
        let fanCount = 0;
        bnds[0] = Infinity;
        bnds[1] = Infinity;
        bnds[2] = -Infinity;
        bnds[3] = -Infinity;
        for (const contour of op.contours) {
            const shape = sampleContour(contour, frame);
            if (!shape) {
                continue;
            }
            pts.length = 0;
            const np = buildContourPoints(shape, m, pts);
            if (np < 2) {
                continue;
            }
            fanCount += emitWindingFan(pts, np, verts, bnds);
        }
        if (fanCount === 0) {
            return;
        }

        const coverFirst = verts.length / 2;
        pushCoverQuad(verts, bnds[0], bnds[1], bnds[2], bnds[3]);

        const paintIndex = writePaintBlock(op, m, frame, alpha);
        draws.push({ stroke: false, fanFirst, fanCount, coverFirst, coverCount: 6, paintIndex });
    }

    function emitStroke(op: DrawOp, m: Mat2D, frame: number, alpha: number): void {
        if (op.paint.kind !== "stroke") {
            return;
        }
        // Stroke width scales with the transform; half-width in screen pixels.
        const scale = Math.hypot(m[0], m[1]);
        const halfWidth = (sampleScalar(op.paint.width, frame, 0) * scale) / 2;
        if (halfWidth <= 0) {
            return;
        }
        const fanFirst = verts.length / 2;
        let fanCount = 0;
        bnds[0] = Infinity;
        bnds[1] = Infinity;
        bnds[2] = -Infinity;
        bnds[3] = -Infinity;
        for (const contour of op.contours) {
            const shape = sampleContour(contour, frame);
            if (!shape) {
                continue;
            }
            pts.length = 0;
            const np = buildContourPoints(shape, m, pts);
            if (np < 2) {
                continue;
            }
            const before = verts.length;
            fanCount += buildStrokePoints(pts, np, halfWidth, shape.c, verts, op.paint.cap);
            // The expanded stroke triangles bound the cover quad.
            for (let vi = before; vi < verts.length; vi += 2) {
                const x = verts[vi];
                const y = verts[vi + 1];
                if (x < bnds[0]) {
                    bnds[0] = x;
                }
                if (y < bnds[1]) {
                    bnds[1] = y;
                }
                if (x > bnds[2]) {
                    bnds[2] = x;
                }
                if (y > bnds[3]) {
                    bnds[3] = y;
                }
            }
        }
        if (fanCount === 0) {
            return;
        }
        const coverFirst = verts.length / 2;
        pushCoverQuad(verts, bnds[0], bnds[1], bnds[2], bnds[3]);
        const paintIndex = writePaintBlock(op, m, frame, alpha);
        draws.push({ stroke: true, fanFirst, fanCount, coverFirst, coverCount: 6, paintIndex });
    }

    // Build a layer's mask geometry into `verts`: a winding fan for each supported (add-mode,
    // non-inverted) mask path, plus a union bounding quad used by the resolve + teardown stencil
    // passes. Returns the fan/bbox offsets, or null when the layer has no renderable mask. Other
    // mask modes (subtract / intersect / inverted) are intentionally ignored for now, so the layer
    // renders unclipped rather than wrongly clipped.
    function emitMask(masks: ParsedMask[], world: Mat2D, frame: number): { fanFirst: number; fanCount: number; bboxFirst: number } | null {
        const fanFirst = verts.length / 2;
        let fanCount = 0;
        bnds[0] = Infinity;
        bnds[1] = Infinity;
        bnds[2] = -Infinity;
        bnds[3] = -Infinity;
        for (const mask of masks) {
            if (mask.mode !== "a" || mask.inverted) {
                continue;
            }
            const shape = sampleShape(mask.path, frame);
            pts.length = 0;
            const np = buildContourPoints(shape, world, pts);
            if (np < 2) {
                continue;
            }
            fanCount += emitWindingFan(pts, np, verts, bnds);
        }
        if (fanCount === 0) {
            return null;
        }
        const bboxFirst = verts.length / 2;
        pushCoverQuad(verts, bnds[0], bnds[1], bnds[2], bnds[3]);
        return { fanFirst, fanCount, bboxFirst };
    }

    function ensureBuffers(vec2Count: number): void {
        const neededFloats = Math.max(vec2Count * 2, 2);
        if (!vbo || vertCapacity < neededFloats) {
            if (vbo) {
                disposeBuffer(engine, vbo);
            }
            vertCapacity = Math.max(neededFloats, Math.ceil((vertCapacity || 8192) * 1.5));
            vertData = new Float32Array(vertCapacity);
            vbo = createVertexBuffer(engine, vertData, true);
        }
        const neededIdx = Math.max(vec2Count, 3);
        if (!seqIb || seqCapacity < neededIdx) {
            if (seqIb) {
                disposeBuffer(engine, seqIb);
            }
            seqCapacity = Math.max(neededIdx, Math.ceil((seqCapacity || 8192) * 1.5));
            const seq = new Uint32Array(seqCapacity);
            for (let i = 0; i < seqCapacity; i++) {
                seq[i] = i;
            }
            seqIb = createIndexBuffer(engine, seq);
        }
    }

    const isReady = (): boolean => isEffectReady(engine, stencilEffect) && isEffectReady(engine, coverEffect);

    function stencilGeometry(stroke: boolean, fanFirst: number, fanCount: number, ib: GLIndexBuffer, func: GLenum, ref: number, funcMask: number): void {
        useEffect(engine, stencilEffect);
        setColorMask(engine, false, false, false, false);
        if (stroke) {
            setCullState(engine, false);
            setStencilState(engine, { test: true, mask: WINDING_MASK, func, ref, funcMask, opFail: gl.KEEP, opZFail: gl.KEEP, opZPass: gl.INCR });
            drawIndexed(engine, ib, fanCount, fanFirst);
        } else {
            setStencilState(engine, { test: true, mask: WINDING_MASK, func, ref, funcMask, opFail: gl.KEEP, opZFail: gl.KEEP });
            setCullState(engine, true, gl.BACK);
            setStencilState(engine, { opZPass: gl.INCR_WRAP });
            drawIndexed(engine, ib, fanCount, fanFirst);
            setCullState(engine, true, gl.FRONT);
            setStencilState(engine, { opZPass: gl.DECR_WRAP });
            drawIndexed(engine, ib, fanCount, fanFirst);
        }
    }

    function resolveClip(ib: GLIndexBuffer, coverFirst: number, bit: number): void {
        setCullState(engine, false);
        setStencilState(engine, {
            test: true,
            mask: WINDING_MASK | bit,
            func: gl.NOTEQUAL,
            ref: bit,
            funcMask: WINDING_MASK,
            opFail: gl.KEEP,
            opZFail: gl.KEEP,
            opZPass: gl.REPLACE,
        });
        drawIndexed(engine, ib, 6, coverFirst);
    }

    function setupLayerMask(token: number, ib: GLIndexBuffer): void {
        stencilGeometry(false, maskFanFirst[token], maskFanCount[token], ib, gl.ALWAYS, 0, WINDING_MASK);
        resolveClip(ib, maskBboxFirst[token], MASK_BIT);
    }

    function clearLayerMask(token: number, ib: GLIndexBuffer): void {
        useEffect(engine, stencilEffect);
        setColorMask(engine, false, false, false, false);
        setCullState(engine, false);
        setStencilState(engine, { test: true, mask: MASK_BIT, func: gl.ALWAYS, ref: 0, funcMask: 0xff, opFail: gl.KEEP, opZFail: gl.KEEP, opZPass: gl.REPLACE });
        drawIndexed(engine, ib, 6, maskBboxFirst[token]);
    }

    function setupMatte(token: number, ib: GLIndexBuffer): void {
        const drawStart = ranges[token * 2];
        const drawCount = ranges[token * 2 + 1];
        if (maskHas[token]) {
            setupLayerMask(token, ib);
        }
        for (let i = 0; i < drawCount; i++) {
            const d = draws[drawStart + i];
            stencilGeometry(d.stroke, d.fanFirst, d.fanCount, ib, maskHas[token] ? gl.EQUAL : gl.ALWAYS, maskHas[token] ? MASK_BIT : 0, maskHas[token] ? MASK_BIT : WINDING_MASK);
            resolveClip(ib, d.coverFirst, MATTE_BIT);
        }
        if (maskHas[token]) {
            clearLayerMask(token, ib);
        }
    }

    function clearMatte(token: number, ib: GLIndexBuffer): void {
        const drawStart = ranges[token * 2];
        const drawCount = ranges[token * 2 + 1];
        useEffect(engine, stencilEffect);
        setColorMask(engine, false, false, false, false);
        setCullState(engine, false);
        setStencilState(engine, { test: true, mask: MATTE_BIT, func: gl.ALWAYS, ref: 0, funcMask: 0xff, opFail: gl.KEEP, opZFail: gl.KEEP, opZPass: gl.REPLACE });
        for (let i = 0; i < drawCount; i++) {
            const d = draws[drawStart + i];
            drawIndexed(engine, ib, d.coverCount, d.coverFirst);
        }
    }

    return {
        kind: 4,
        isReady,
        beginFrame() {
            verts.length = 0;
            draws.length = 0;
            ranges.length = 0;
            pKind.length = 0;
            pAlpha.length = 0;
            pSolid.length = 0;
            pGrad.length = 0;
            pStopCount.length = 0;
            pOff.length = 0;
            pCol.length = 0;
            maskHas.length = 0;
            maskFanFirst.length = 0;
            maskFanCount.length = 0;
            maskBboxFirst.length = 0;
        },
        emitLayer(layer: ParsedLayer, world: Mat2D, layerAlpha: number, ctx: LayerRenderContext): number {
            const drawStart = draws.length;
            // Lottie renders shape items back-to-front: iterate in reverse array order.
            for (let oi = layer.ops.length - 1; oi >= 0; oi--) {
                emitOp(layer.ops[oi], world, ctx.frame, layerAlpha);
            }
            const count = draws.length - drawStart;
            if (count === 0) {
                return -1;
            }
            // Build mask geometry AFTER content, so a layer that emits nothing pays nothing for it.
            const mask = layer.masks ? emitMask(layer.masks, world, ctx.frame) : null;
            const token = ranges.length / 2;
            ranges.push(drawStart, count);
            maskHas[token] = mask !== null;
            maskFanFirst[token] = mask ? mask.fanFirst : 0;
            maskFanCount[token] = mask ? mask.fanCount : 0;
            maskBboxFirst[token] = mask ? mask.bboxFirst : 0;
            return token;
        },
        flush(ctx: LayerRenderContext) {
            const vertexCount = verts.length / 2;
            ensureBuffers(Math.max(vertexCount, 1));
            if (vertexCount > 0 && vbo) {
                vertData.set(verts);
                updateVertexBuffer(engine, vbo, vertData.subarray(0, verts.length));
            }
            // uScreen is constant per frame; lite-gl's setters cache, so set on both programs.
            useEffect(engine, stencilEffect);
            setEffectFloat2(engine, stencilEffect, "uScreen", ctx.screenW, ctx.screenH);
            useEffect(engine, coverEffect);
            setEffectFloat2(engine, coverEffect, "uScreen", ctx.screenW, ctx.screenH);
        },
        recordLayer(token: number, matteToken?: number) {
            const drawStart = ranges[token * 2];
            const drawCount = ranges[token * 2 + 1];
            if (drawCount === 0 || !seqIb || !vbo) {
                return;
            }
            // (Re)bind our single position attribute on the shared default VAO. The text renderer
            // (interleaved by z-order) binds its own pos/uv/alpha layout, so we must restore ours
            // before each layer's draws rather than once per frame.
            bindAttributes(engine, vbo, [{ name: "position", size: 2, offset: 0, divisor: 0 }], stencilEffect);
            const masked = maskHas[token];
            const matted = matteToken !== undefined;

            if (matted) {
                setupMatte(matteToken, seqIb);
            }
            if (masked) {
                setupLayerMask(token, seqIb);
            }

            const clipBits = (masked ? MASK_BIT : 0) | (matted ? MATTE_BIT : 0);
            const cFunc = clipBits ? gl.EQUAL : gl.ALWAYS;
            const cFuncMask = clipBits || WINDING_MASK;

            for (let i = 0; i < drawCount; i++) {
                const d = draws[drawStart + i];
                stencilGeometry(d.stroke, d.fanFirst, d.fanCount, seqIb, cFunc, clipBits, cFuncMask);

                // ── COVER pass: paint where winding (low bits) != 0, reset the winding to 0 while
                //    preserving the mask/matte bits, blend premultiplied.
                useEffect(engine, coverEffect);
                const pi = d.paintIndex;
                setEffectInt(engine, coverEffect, "uKind", pKind[pi]);
                setEffectFloat(engine, coverEffect, "uAlpha", pAlpha[pi]);
                setEffectFloat4(engine, coverEffect, "uSolid", pSolid[pi * 4], pSolid[pi * 4 + 1], pSolid[pi * 4 + 2], pSolid[pi * 4 + 3]);
                setEffectFloat4(engine, coverEffect, "uGrad", pGrad[pi * 4], pGrad[pi * 4 + 1], pGrad[pi * 4 + 2], pGrad[pi * 4 + 3]);
                setEffectInt(engine, coverEffect, "uStopCount", pStopCount[pi]);
                offScratch.set(pOff.slice(pi * GS, (pi + 1) * GS));
                colScratch.set(pCol.slice(pi * GS * 4, (pi + 1) * GS * 4));
                setEffectFloatArray(engine, coverEffect, "uOffsets", offScratch);
                setEffectFloatArray4(engine, coverEffect, "uColors", colScratch);
                setColorMask(engine, true, true, true, true);
                setCullState(engine, false);
                setBlendMode(engine, GLBlendMode.PREMULTIPLIED);
                setStencilState(engine, { test: true, mask: WINDING_MASK, func: gl.NOTEQUAL, ref: 0, funcMask: WINDING_MASK, opFail: gl.KEEP, opZFail: gl.KEEP, opZPass: gl.ZERO });
                drawIndexed(engine, seqIb, d.coverCount, d.coverFirst);
            }

            if (masked) {
                clearLayerMask(token, seqIb);
            }
            if (matted) {
                clearMatte(matteToken, seqIb);
            }
        },
        dispose() {
            if (vbo) {
                disposeBuffer(engine, vbo);
                vbo = null;
            }
            if (seqIb) {
                disposeBuffer(engine, seqIb);
                seqIb = null;
            }
            disposeEffect(engine, stencilEffect);
            disposeEffect(engine, coverEffect);
        },
    };
}
