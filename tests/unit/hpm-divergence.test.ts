/**
 * Cross-golden divergence test (LWR M1 proof gate).
 *
 * Asserts that scene 200 (HPM-off, floating-origin off) and scene 201
 * (HPM-on, floating-origin on) produce visibly different golden images
 * when rendered at world coordinates ~1e6. If both goldens are pixel-
 * identical, the HPM substrate + floating-origin trick are not actually
 * load-bearing — which is the failure mode this test exists to catch.
 *
 * Threshold: MAD must exceed 1.0 (well above the per-scene tolerance of
 * scene 200's `maxMad: 5.0` and scene 201's `maxMad: 0.5`). At magnitude
 * 1e6 the F32 baseline (scene 200) loses ~0.06 m per ULP in the view
 * chain, producing visibly stair-stepped silhouettes on the satellites.
 * The HPM-on + floating-origin path (scene 201) renders the same scene
 * with crisp edges. The cross-golden MAD captures that delta.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const SCENE200_GOLDEN = resolve(__dirname, "../../reference/scene200-high-precision-jitter-hpm-off/babylon-ref-golden.png");
const SCENE201_GOLDEN = resolve(__dirname, "../../reference/scene201-high-precision-jitter-hpm-on/babylon-ref-golden.png");

function loadPng(p: string): PNG {
    return PNG.sync.read(readFileSync(p));
}

interface Stats {
    mad: number;
    differingPixels: number;
    totalPixels: number;
    maxDiff: number;
}

function imageMad(a: PNG, b: PNG): Stats {
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    let sum = 0;
    let maxDiff = 0;
    let differing = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ai = (y * a.width + x) * 4;
            const bi = (y * b.width + x) * 4;
            let pixMax = 0;
            let pixSum = 0;
            for (let c = 0; c < 3; c++) {
                const d = Math.abs(a.data[ai + c]! - b.data[bi + c]!);
                pixSum += d;
                if (d > pixMax) {
                    pixMax = d;
                }
            }
            sum += pixSum / 3;
            if (pixMax > maxDiff) {
                maxDiff = pixMax;
            }
            if (pixMax > 0) {
                differing++;
            }
        }
    }
    return { mad: sum / (w * h), differingPixels: differing, totalPixels: w * h, maxDiff };
}

describe("LWR M1 — scene 200 vs scene 201 divergence proof", () => {
    it("scene 200 and scene 201 goldens must visibly diverge (MAD > 1.0)", () => {
        const a = loadPng(SCENE200_GOLDEN);
        const b = loadPng(SCENE201_GOLDEN);
        const stats = imageMad(a, b);

        // Surface the numbers in the test log even on pass so the divergence
        // magnitude is auditable.

        console.warn(
            `scene200 vs scene201 cross-golden: MAD=${stats.mad.toFixed(3)}, ` + `differingPixels=${stats.differingPixels}/${stats.totalPixels}, maxDiff=${stats.maxDiff}`
        );

        expect(
            stats.mad,
            `LWR M1 proof gate: HPM-on + floating-origin must visibly differ from HPM-off F32 baseline at world coords ~1e6. ` +
                `If this fails with MAD~0, the offset is being undone somewhere downstream — investigate the upload path before adjusting the threshold.`
        ).toBeGreaterThan(1.0);
    });

    it("scene 200 and scene 201 goldens differ on a substantial pixel count (> 1% of frame)", () => {
        const a = loadPng(SCENE200_GOLDEN);
        const b = loadPng(SCENE201_GOLDEN);
        const stats = imageMad(a, b);
        const minDifferingFraction = 0.01;
        expect(
            stats.differingPixels / stats.totalPixels,
            `Expected at least ${minDifferingFraction * 100}% of pixels to differ; got ${((stats.differingPixels / stats.totalPixels) * 100).toFixed(2)}%`
        ).toBeGreaterThan(minDifferingFraction);
    });
});
