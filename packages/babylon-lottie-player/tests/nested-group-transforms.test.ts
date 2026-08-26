import { describe, expect, it } from "vitest";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { parseAnimation } from "../src/animation/parse.js";

const prop = (k: unknown) => ({ a: 0 as const, k });
const transform = (x: number, opacity: number) => ({ ty: "tr", p: prop([x, 0]), a: prop([0, 0]), s: prop([100, 100]), r: prop(0), o: prop(opacity) });

describe("nested group transforms", () => {
    it("preserves transforms from outermost to innermost", () => {
        const file = {
            v: "5.7.0",
            w: 100,
            h: 100,
            ip: 0,
            op: 2,
            fr: 30,
            layers: [
                {
                    ind: 1,
                    ty: 4,
                    ks: {},
                    ip: 0,
                    op: 2,
                    st: 0,
                    shapes: [
                        {
                            ty: "gr",
                            it: [
                                {
                                    ty: "gr",
                                    it: [{ ty: "rc", p: prop([0, 0]), s: prop([20, 20]), r: prop(0) }, { ty: "fl", c: prop([1, 0, 0, 1]), o: prop(100) }, transform(20, 80)],
                                },
                                transform(40, 60),
                            ],
                        },
                    ],
                },
            ],
        } as unknown as LottieFile;

        const op = parseAnimation(file).layers[0].ops[0];

        expect(op.transforms).toHaveLength(2);
        expect(op.transforms.map((entry) => entry.p?.k)).toEqual([
            [40, 0],
            [20, 0],
        ]);
        expect(op.transforms.map((entry) => entry.o?.k)).toEqual([60, 80]);
    });
});
