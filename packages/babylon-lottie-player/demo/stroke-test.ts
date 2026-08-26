// Synthetic stroke + fill test document for @babylonjs/lottie-player validation.
// Hand-authored Lottie exercising: an open polyline stroke (checkmark),
// a closed ellipse stroke (ring), and a filled circle, on a solid background. Lets us confirm
// strokes render as lines independent of any product animation's timeline.

import type { LottieFile } from "../src/animation/lottie-raw.js";

export const STROKE_TEST: LottieFile = {
    v: "5.7.0",
    fr: 30,
    ip: 0,
    op: 60,
    w: 400,
    h: 400,
    layers: [
        // Shape layer FIRST = topmost (Lottie z-order: earlier array index draws on top):
        // checkmark (open stroke), ring (closed stroke), dot (fill).
        {
            ind: 2,
            ty: 4,
            ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 } },
            ip: 0,
            op: 60,
            st: 0,
            shapes: [
                // Checkmark: open 3-vertex polyline, thick green stroke.
                {
                    ty: "gr",
                    it: [
                        {
                            ty: "sh",
                            ks: {
                                a: 0,
                                k: {
                                    i: [
                                        [0, 0],
                                        [0, 0],
                                        [0, 0],
                                    ],
                                    o: [
                                        [0, 0],
                                        [0, 0],
                                        [0, 0],
                                    ],
                                    v: [
                                        [-110, -10],
                                        [-40, 60],
                                        [110, -90],
                                    ],
                                    c: false,
                                },
                            },
                        },
                        { ty: "st", c: { a: 0, k: [0.3, 0.85, 0.4, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 22 }, lc: 2, lj: 2 },
                        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
                    ],
                },
                // Ring: closed ellipse, thick orange stroke, no fill.
                {
                    ty: "gr",
                    it: [
                        { ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [260, 260] } },
                        { ty: "st", c: { a: 0, k: [0.95, 0.55, 0.15, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 12 }, lc: 2, lj: 2 },
                        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
                    ],
                },
                // Dot: small filled circle (fill regression check next to the strokes).
                {
                    ty: "gr",
                    it: [
                        { ty: "el", p: { a: 0, k: [0, 110] }, s: { a: 0, k: [26, 26] } },
                        { ty: "fl", c: { a: 0, k: [0.4, 0.6, 0.95, 1] }, o: { a: 0, k: 100 } },
                        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
                    ],
                },
            ],
        },
        // Solid background (ty:1) LAST = bottom. A solid's content spans local (0,0)–(sw,sh),
        // so anchor and position are both origin to fill the frame.
        {
            ind: 1,
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
