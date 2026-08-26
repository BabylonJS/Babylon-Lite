// Synthetic mask test for @babylonjs/lottie-player validation.
// A full-frame magenta rectangle on a shape layer, clipped by a single "add" circular mask:
// if masking works the result is a magenta CIRCLE (not a full rect), decisively proving the
// layer content is clipped to the mask path. A second smaller masked element (a wide bar masked
// to a square) confirms masks are per-layer. Navy solid behind everything.

import type { LottieFile } from "../src/animation/lottie-raw.js";

// A radius-r circle as a 4-anchor closed bezier centered at (cx,cy) — the shape format Lottie
// mask paths (and our sampleShape) consume: relative in/out tangents, absolute vertices.
function circlePath(cx: number, cy: number, r: number): { i: number[][]; o: number[][]; v: number[][]; c: boolean } {
    const k = r * 0.5523;
    return {
        v: [
            [cx, cy - r],
            [cx + r, cy],
            [cx, cy + r],
            [cx - r, cy],
        ],
        i: [
            [-k, 0],
            [0, -k],
            [k, 0],
            [0, k],
        ],
        o: [
            [k, 0],
            [0, k],
            [-k, 0],
            [0, -k],
        ],
        c: true,
    };
}

// A w×h axis-aligned rectangle as a 4-anchor closed bezier (zero tangents) centered at (cx,cy).
function rectPath(cx: number, cy: number, w: number, h: number): { i: number[][]; o: number[][]; v: number[][]; c: boolean } {
    const hw = w / 2;
    const hh = h / 2;
    const z: number[][] = [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
    ];
    return {
        v: [
            [cx - hw, cy - hh],
            [cx + hw, cy - hh],
            [cx + hw, cy + hh],
            [cx - hw, cy + hh],
        ],
        i: z,
        o: z,
        c: true,
    };
}

const tr = { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
const layerKs = { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 } };

export const MASK_TEST: LottieFile = {
    v: "5.7.0",
    fr: 30,
    ip: 0,
    op: 60,
    w: 400,
    h: 400,
    layers: [
        // Top: a full-frame magenta rect, masked by a circle → must render as a magenta circle.
        {
            ind: 1,
            ty: 4,
            ks: layerKs,
            ip: 0,
            op: 60,
            st: 0,
            masksProperties: [{ mode: "a", inv: false, o: { a: 0, k: 100 }, pt: { a: 0, k: circlePath(0, -40, 120) } }],
            shapes: [
                {
                    ty: "gr",
                    it: [
                        { ty: "sh", ks: { a: 0, k: rectPath(0, 0, 400, 400) } },
                        { ty: "fl", c: { a: 0, k: [0.9, 0.2, 0.7, 1] }, o: { a: 0, k: 100 } },
                        { ty: "tr", ...tr },
                    ],
                },
            ],
        },
        // Middle: a wide cyan bar, masked to a square → must render as a cyan square.
        {
            ind: 2,
            ty: 4,
            ks: layerKs,
            ip: 0,
            op: 60,
            st: 0,
            masksProperties: [{ mode: "a", inv: false, o: { a: 0, k: 100 }, pt: { a: 0, k: rectPath(0, 120, 80, 80) } }],
            shapes: [
                {
                    ty: "gr",
                    it: [
                        { ty: "sh", ks: { a: 0, k: rectPath(0, 120, 360, 120) } },
                        { ty: "fl", c: { a: 0, k: [0.3, 0.8, 0.9, 1] }, o: { a: 0, k: 100 } },
                        { ty: "tr", ...tr },
                    ],
                },
            ],
        },
        // Bottom: navy background so the clipped shapes are obvious.
        {
            ind: 3,
            ty: 1,
            sc: "#202830",
            sw: 400,
            sh: 400,
            ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 } },
            ip: 0,
            op: 60,
            st: 0,
        },
    ],
};
