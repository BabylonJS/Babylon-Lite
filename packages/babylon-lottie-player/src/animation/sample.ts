// Per-frame sampling of raw Lottie properties (scalars, vectors, and morphing shapes),
// with standard Lottie cubic-bezier keyframe easing. All functions are pure.

import type { Easing, Keyframe, Prop, ShapeData } from "./lottie-raw.js";

function comp(e: Easing | undefined, axis: "x" | "y", fallback: number): number {
    if (!e) {
        return fallback;
    }
    const val = e[axis];
    return Array.isArray(val) ? val[0] : val;
}

// CSS-style cubic-bezier solve: control points (x1,y1),(x2,y2); endpoints (0,0),(1,1).
// Given the linear fraction `x`, return the eased fraction `y`.
function bezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
    if (x <= 0) {
        return 0;
    }
    if (x >= 1) {
        return 1;
    }
    const ax = 1 - 3 * x2 + 3 * x1;
    const bx = 3 * x2 - 6 * x1;
    const cx = 3 * x1;
    const ay = 1 - 3 * y2 + 3 * y1;
    const by = 3 * y2 - 6 * y1;
    const cy = 3 * y1;
    // Newton-Raphson to invert X(t) = x.
    let t = x;
    for (let i = 0; i < 8; i++) {
        const xt = ((ax * t + bx) * t + cx) * t - x;
        if (Math.abs(xt) < 1e-6) {
            break;
        }
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) {
            break;
        }
        t -= xt / d;
    }
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return ((ay * t + by) * t + cy) * t;
}

interface Segment {
    k: Keyframe;
    next: Keyframe | null;
    /** Eased interpolation fraction in [0,1]. */
    f: number;
}

function findSegment(keys: Keyframe[], frame: number): Segment {
    if (frame <= keys[0].t) {
        return { k: keys[0], next: keys[1] ?? null, f: 0 };
    }
    const last = keys[keys.length - 1];
    if (frame >= last.t) {
        return { k: last, next: null, f: 0 };
    }
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= frame) {
        i++;
    }
    const k = keys[i];
    const next = keys[i + 1];
    if (k.h === 1) {
        return { k, next, f: 0 };
    }
    const lin = (frame - k.t) / (next.t - k.t);
    const f = bezier(lin, comp(k.o, "x", 0), comp(k.o, "y", 0), comp(k.i, "x", 1), comp(k.i, "y", 1));
    return { k, next, f };
}

function asNumber(v: unknown): number {
    return Array.isArray(v) ? (v[0] as number) : (v as number);
}

/** Sample a scalar property (e.g. opacity, rotation). */
export function sampleScalar(prop: Prop | undefined, frame: number, fallback: number): number {
    if (!prop) {
        return fallback;
    }
    if (prop.a !== 1) {
        return asNumber(prop.k);
    }
    const keys = prop.k as Keyframe[];
    const { k, next, f } = findSegment(keys, frame);
    const v0 = asNumber(k.s);
    if (!next || f === 0) {
        return v0;
    }
    const v1 = asNumber(k.e !== undefined ? k.e : next.s);
    return v0 + (v1 - v0) * f;
}

/** Sample a multi-dimensional property (e.g. position, scale, anchor, color) into `out`. */
export function sampleMulti(prop: Prop | undefined, frame: number, out: number[]): number[] {
    if (!prop) {
        return out;
    }
    // Separate-dimensions position (`{ s: true, x, y }`): each axis is its own scalar property.
    if (prop.s === true) {
        out[0] = sampleScalar(prop.x, frame, 0);
        out[1] = sampleScalar(prop.y, frame, 0);
        return out;
    }
    if (prop.a !== 1) {
        const k = prop.k as number[];
        for (let i = 0; i < k.length; i++) {
            out[i] = k[i];
        }
        return out;
    }
    const keys = prop.k as Keyframe[];
    const { k, next, f } = findSegment(keys, frame);
    const s0 = k.s as number[];
    if (!next || f === 0) {
        for (let i = 0; i < s0.length; i++) {
            out[i] = s0[i];
        }
        return out;
    }
    const s1 = (k.e !== undefined ? k.e : next.s) as number[];
    for (let i = 0; i < s0.length; i++) {
        out[i] = s0[i] + (s1[i] - s0[i]) * f;
    }
    return out;
}

/**
 * Sample a morphing shape property. Lottie guarantees a constant vertex count across a
 * path's keyframes, so morphing is a straight per-vertex lerp of vertices + in/out tangents.
 */
export function sampleShape(prop: Prop, frame: number): ShapeData {
    if (prop.a !== 1) {
        return prop.k as ShapeData;
    }
    const keys = prop.k as Keyframe[];
    const { k, next, f } = findSegment(keys, frame);
    const s0 = (k.s as ShapeData[])[0];
    if (!next || f === 0) {
        return s0;
    }
    const s1 = ((k.e !== undefined ? k.e : next.s) as ShapeData[])[0];
    const n = s0.v.length;
    const v: [number, number][] = new Array(n);
    const inT: [number, number][] = new Array(n);
    const outT: [number, number][] = new Array(n);
    for (let j = 0; j < n; j++) {
        v[j] = [s0.v[j][0] + (s1.v[j][0] - s0.v[j][0]) * f, s0.v[j][1] + (s1.v[j][1] - s0.v[j][1]) * f];
        inT[j] = [s0.i[j][0] + (s1.i[j][0] - s0.i[j][0]) * f, s0.i[j][1] + (s1.i[j][1] - s0.i[j][1]) * f];
        outT[j] = [s0.o[j][0] + (s1.o[j][0] - s0.o[j][0]) * f, s0.o[j][1] + (s1.o[j][1] - s0.o[j][1]) * f];
    }
    return { v, i: inT, o: outT, c: s0.c };
}

/**
 * Sample a rect primitive into a `ShapeData` contour. Position `p` is the center, `s` the
 * size, `r` the corner roundness. Sharp corners (r ~ 0) → 4 straight-edged vertices; rounded
 * corners → 8 vertices with bezier tangents approximating the quarter-circle arcs.
 */
export function sampleRect(rect: { p: Prop; s: Prop; r?: Prop }, frame: number): ShapeData {
    const c = sampleMulti(rect.p, frame, [0, 0]);
    const cx = c[0];
    const cy = c[1];
    const size = sampleMulti(rect.s, frame, [0, 0]);
    const hw = size[0] / 2;
    const hh = size[1] / 2;
    let round = rect.r ? sampleScalar(rect.r, frame, 0) : 0;
    round = Math.min(round, hw, hh);

    if (round <= 0.01) {
        // Sharp rect: 4 corners, clockwise from top-right (Lottie's rect winding), zero tangents.
        const v: [number, number][] = [
            [cx + hw, cy - hh],
            [cx + hw, cy + hh],
            [cx - hw, cy + hh],
            [cx - hw, cy - hh],
        ];
        const zeros = (): [number, number][] => [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
        ];
        return { v, i: zeros(), o: zeros(), c: true };
    }

    // Rounded rect: 8 vertices (2 per corner) with bezier tangents approximating the arcs.
    // Bezier handle length for a circular quarter-arc of radius `round`.
    const k = round * 0.5523;
    const v: [number, number][] = [];
    const inT: [number, number][] = [];
    const outT: [number, number][] = [];
    const push = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): void => {
        v.push([x, y]);
        inT.push([ix, iy]);
        outT.push([ox, oy]);
    };
    // Clockwise from the right edge. Each corner contributes two anchors with arc tangents.
    push(cx + hw, cy - hh + round, 0, -k, 0, 0); // right edge, top
    push(cx + hw, cy + hh - round, 0, 0, 0, k); // right edge, bottom
    push(cx + hw - round, cy + hh, k, 0, 0, 0); // bottom edge, right
    push(cx - hw + round, cy + hh, 0, 0, -k, 0); // bottom edge, left
    push(cx - hw, cy + hh - round, 0, k, 0, 0); // left edge, bottom
    push(cx - hw, cy - hh + round, 0, 0, 0, -k); // left edge, top
    push(cx - hw + round, cy - hh, -k, 0, 0, 0); // top edge, left
    push(cx + hw - round, cy - hh, 0, 0, k, 0); // top edge, right
    return { v, i: inT, o: outT, c: true };
}

/**
 * Sample an ellipse primitive into a `ShapeData` contour: 4 anchor points (top, right, bottom,
 * left) with bezier tangents (handle length 0.5523 × radius) that approximate the arc.
 */
export function sampleEllipse(ellipse: { p: Prop; s: Prop }, frame: number): ShapeData {
    const c = sampleMulti(ellipse.p, frame, [0, 0]);
    const cx = c[0];
    const cy = c[1];
    const size = sampleMulti(ellipse.s, frame, [0, 0]);
    const rx = size[0] / 2;
    const ry = size[1] / 2;
    const kx = rx * 0.5523;
    const ky = ry * 0.5523;
    // Clockwise from the top: top, right, bottom, left.
    const v: [number, number][] = [
        [cx, cy - ry],
        [cx + rx, cy],
        [cx, cy + ry],
        [cx - rx, cy],
    ];
    const inT: [number, number][] = [
        [-kx, 0],
        [0, -ky],
        [kx, 0],
        [0, ky],
    ];
    const outT: [number, number][] = [
        [kx, 0],
        [0, ky],
        [-kx, 0],
        [0, -ky],
    ];
    return { v, i: inT, o: outT, c: true };
}
