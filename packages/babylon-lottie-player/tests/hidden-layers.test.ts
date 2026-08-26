import { describe, expect, it } from "vitest";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { parseAnimation } from "../src/animation/parse.js";

describe("hidden layers", () => {
    it("retains a hidden parent as a non-rendering transform node", () => {
        const file = {
            v: "5.7.0",
            w: 100,
            h: 100,
            ip: 0,
            op: 2,
            fr: 30,
            layers: [
                { ind: 1, ty: 3, hd: true, ks: { p: { a: 0, k: [40, 20] } }, ip: 0, op: 2, st: 0 },
                { ind: 2, ty: 3, parent: 1, ks: { p: { a: 0, k: [5, 0] } }, ip: 0, op: 2, st: 0 },
            ],
        } as unknown as LottieFile;

        const layers = parseAnimation(file).layers;

        expect(layers).toHaveLength(2);
        expect(layers[0]).toMatchObject({ ind: 1, kind: 3, matteOnly: true });
        expect(layers[1]).toMatchObject({ ind: 2, parent: 1 });
    });

    it("does not turn a hidden matte source back into matte coverage", () => {
        const file = {
            v: "5.7.0",
            w: 100,
            h: 100,
            ip: 0,
            op: 2,
            fr: 30,
            layers: [
                { ind: 1, ty: 3, td: 1, hd: true, ks: {}, ip: 0, op: 2, st: 0 },
                { ind: 2, ty: 3, tt: 1, ks: {}, ip: 0, op: 2, st: 0 },
            ],
        } as unknown as LottieFile;

        const layers = parseAnimation(file).layers;

        expect(layers[0]).toMatchObject({ ind: 1, kind: 3, matteOnly: true });
        expect(layers[1]).toMatchObject({ ind: 2, matteMode: 1, matteSource: 1 });
    });
});
