import { describe, it, expect } from "vitest";
import { parseAnimation } from "../src/animation/parse.js";
import type { LottieFile } from "../src/animation/lottie-raw.js";

// A minimal single-text-layer Lottie document. `t` is the raw text content a `variables` map can
// replace at runtime (whole-string key match), mirroring the original Babylon.js Lottie player.
function docWithText(text: string): LottieFile {
    return {
        w: 100,
        h: 100,
        ip: 0,
        op: 10,
        fr: 30,
        fonts: { list: [{ fName: "F", fFamily: "Segoe UI", fWeight: "400", fStyle: "Regular" }] },
        layers: [
            {
                ty: 5,
                ind: 1,
                ks: {},
                ip: 0,
                op: 10,
                st: 0,
                nm: "t",
                t: { d: { k: [{ s: { t: text, f: "F", s: 24, fc: [0, 0, 0], j: 0 } }] } },
            },
        ],
    } as unknown as LottieFile;
}

/** Parse `file` with `variables` and return the (possibly substituted) text of its text layer. */
function textOf(file: LottieFile, variables?: Record<string, string>): string {
    const layer = parseAnimation(file, variables).layers.find((l) => l.text);
    if (!layer?.text) {
        throw new Error("expected a parsed text layer");
    }
    return layer.text.text;
}

describe("runtime text substitution", () => {
    it("renders the raw text when no variables are given", () => {
        expect(textOf(docWithText("title1"))).toBe("title1");
    });

    it("substitutes a placeholder whose whole text matches a variable key", () => {
        expect(textOf(docWithText("title1"), { title1: "Welcome!" })).toBe("Welcome!");
    });

    it("leaves text unchanged when no key matches", () => {
        expect(textOf(docWithText("title1"), { other: "X" })).toBe("title1");
    });

    it("honors an empty-string replacement (blank-out localization)", () => {
        expect(textOf(docWithText("title1"), { title1: "" })).toBe("");
    });

    it("does not treat inherited Object keys as variables (e.g. a 'toString' placeholder)", () => {
        expect(textOf(docWithText("toString"), {})).toBe("toString");
    });
});
