/**
 * Golden-diff robustness checks.
 *
 * Verifies the Tier-3 comparison is forgiving of small (1–2 px) vertical
 * envelope shifts — the kind a native audio renderer can introduce across
 * platforms — while still catching genuinely different images. Pure pixel math,
 * so this runs everywhere (no `node-web-audio-api` required).
 */

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { comparePngBuffers, renderWaveformPng } from "../_shared/waveform-png.js";

const BACKGROUND: [number, number, number] = [16, 16, 20];

/** Builds a synthetic linear fade-in tone (triangular envelope, sloped edges). */
function syntheticFadeIn(frequency: number, seconds: number, sampleRate = 44100, amplitude = 0.9): Float32Array {
    const length = Math.ceil(seconds * sampleRate);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        const env = i / length;
        data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * env;
    }
    return data;
}

/** Returns a copy of an encoded PNG shifted vertically by `dy` rows. */
function shiftVertical(pngBuffer: Buffer, dy: number): Buffer {
    const src = PNG.sync.read(pngBuffer);
    const out = new PNG({ width: src.width, height: src.height });
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const di = (y * src.width + x) * 4;
            const sy = y - dy;
            if (sy < 0 || sy >= src.height) {
                out.data[di] = BACKGROUND[0];
                out.data[di + 1] = BACKGROUND[1];
                out.data[di + 2] = BACKGROUND[2];
                out.data[di + 3] = 255;
            } else {
                const si = (sy * src.width + x) * 4;
                out.data[di] = src.data[si]!;
                out.data[di + 1] = src.data[si + 1]!;
                out.data[di + 2] = src.data[si + 2]!;
                out.data[di + 3] = src.data[si + 3]!;
            }
        }
    }
    return PNG.sync.write(out);
}

describe("Tier-3 golden-diff robustness", () => {
    const reference = renderWaveformPng(syntheticFadeIn(440, 0.2));

    it("tolerates a 2 px vertical shift", () => {
        const shifted = shiftVertical(reference, 2);
        const { mismatchFraction } = comparePngBuffers(shifted, reference);
        expect(mismatchFraction).toBeLessThan(0.005);
    });

    it("still flags a large (12 px) vertical shift", () => {
        const small = comparePngBuffers(shiftVertical(reference, 2), reference).mismatchFraction;
        const large = comparePngBuffers(shiftVertical(reference, 12), reference).mismatchFraction;
        // The large shift must be both clearly non-trivial and far worse than
        // the tolerated small shift, proving the diff still detects real change.
        expect(large).toBeGreaterThan(0.02);
        expect(large).toBeGreaterThan(small * 10);
    });
});
