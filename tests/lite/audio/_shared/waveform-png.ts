/**
 * Tier-3 deterministic waveform rasterizer + golden comparison.
 *
 * Draws an offline-rendered PCM channel to an RGBA PNG (a min/max envelope
 * waveform, the same value→Y mapping idea the runtime canvas visualizer uses)
 * and diffs it against a committed golden image.
 *
 * The runtime visualizer (`audio/visualizer.ts`) draws through a DOM
 * `CanvasRenderingContext2D`, which is unavailable under Node without an extra
 * native canvas dependency. This rasterizer is a dependency-light, fully
 * deterministic stand-in used ONLY by the Tier-3 golden tests — it is not part
 * of the shipped engine. Goldens are regenerated only when
 * `UPDATE_AUDIO_GOLDENS=1` is set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `reference/lite/audio` — where Tier-3 golden PNGs live. */
export const AUDIO_GOLDEN_DIR = join(HERE, "..", "..", "..", "..", "reference", "lite", "audio");

/** Options for {@link renderWaveformPng}. */
export interface WaveformPngOptions {
    /** Image width, in pixels. Defaults to `256`. */
    width?: number;
    /** Image height, in pixels. Defaults to `128`. */
    height?: number;
    /** Background `[r, g, b]`. Defaults to `[16, 16, 20]`. */
    background?: [number, number, number];
    /** Waveform `[r, g, b]`. Defaults to `[255, 255, 255]`. */
    waveform?: [number, number, number];
    /**
     * Half-thickness of the drawn waveform band, in pixels. The envelope is
     * padded by this many rows above and below, so a thicker (more forgiving)
     * line is drawn. Defaults to `2` (≈ 5 px thick).
     */
    thickness?: number;
}

function valueToY(value: number, height: number): number {
    // Sample +1 → top (y=0), −1 → bottom (y=height-1).
    const clamped = Math.max(-1, Math.min(1, value));
    const y = Math.round((1 - (clamped + 1) / 2) * (height - 1));
    return Math.max(0, Math.min(height - 1, y));
}

/**
 * Rasterizes a PCM channel as a min/max envelope waveform into a PNG buffer.
 * Fully deterministic: identical input bytes always yield identical output. The
 * band is intentionally drawn thick (see {@link WaveformPngOptions.thickness})
 * so the golden diff is forgiving of sub-pixel envelope shifts.
 * @param channel - The PCM samples to draw.
 * @param options - Image size, colors, and line thickness.
 * @returns The encoded PNG bytes.
 */
export function renderWaveformPng(channel: Float32Array, options: WaveformPngOptions = {}): Buffer {
    const width = options.width ?? 256;
    const height = options.height ?? 128;
    const [bgR, bgG, bgB] = options.background ?? [16, 16, 20];
    const [wR, wG, wB] = options.waveform ?? [255, 255, 255];
    const pad = Math.max(0, options.thickness ?? 2);

    const png = new PNG({ width, height });
    // Fill background.
    for (let i = 0; i < width * height; i++) {
        png.data[i * 4] = bgR;
        png.data[i * 4 + 1] = bgG;
        png.data[i * 4 + 2] = bgB;
        png.data[i * 4 + 3] = 255;
    }

    const samplesPerCol = Math.max(1, Math.floor(channel.length / width));
    for (let x = 0; x < width; x++) {
        const start = x * samplesPerCol;
        const end = Math.min(channel.length, start + samplesPerCol);
        if (end <= start) {
            continue;
        }
        let min = Infinity;
        let max = -Infinity;
        for (let i = start; i < end; i++) {
            const v = channel[i]!;
            if (v < min) {
                min = v;
            }
            if (v > max) {
                max = v;
            }
        }
        // Pad the band so the drawn line is thick and shift-tolerant.
        const yTop = Math.max(0, valueToY(max, height) - pad);
        const yBottom = Math.min(height - 1, valueToY(min, height) + pad);
        for (let y = yTop; y <= yBottom; y++) {
            const idx = (y * width + x) * 4;
            png.data[idx] = wR;
            png.data[idx + 1] = wG;
            png.data[idx + 2] = wB;
            png.data[idx + 3] = 255;
        }
    }

    return PNG.sync.write(png);
}

/** Result of {@link compareToGolden}. */
export interface GoldenComparison {
    /** `true` when the golden was (re)generated this run. */
    updated: boolean;
    /** Fraction of pixels whose per-channel max diff exceeds the tolerance. */
    mismatchFraction: number;
    /** Total compared pixels. */
    totalPixels: number;
}

/**
 * Position-tolerant per-pixel diff of two encoded PNG buffers. A pixel of
 * `actualBuffer` counts as matching if any pixel of `goldenBuffer` within
 * `searchRadius` (Chebyshev distance) is within `perChannelTolerance`.
 * @param actualBuffer - The freshly rendered PNG bytes.
 * @param goldenBuffer - The reference PNG bytes.
 * @param perChannelTolerance - Allowed per-channel byte diff. Defaults to `8`.
 * @param searchRadius - Position tolerance in pixels. Defaults to `2`.
 * @returns The mismatch fraction and compared pixel count.
 */
export function comparePngBuffers(actualBuffer: Buffer, goldenBuffer: Buffer, perChannelTolerance = 8, searchRadius = 2): { mismatchFraction: number; totalPixels: number } {
    const actual = PNG.sync.read(actualBuffer);
    const golden = PNG.sync.read(goldenBuffer);
    // A dimension mismatch is a hard failure: comparing only the overlapping
    // region (via `Math.min`) could let a size regression slip through with an
    // artificially low mismatch fraction.
    if (actual.width !== golden.width || actual.height !== golden.height) {
        return { mismatchFraction: 1, totalPixels: Math.max(actual.width * actual.height, golden.width * golden.height) };
    }
    const w = actual.width;
    const h = actual.height;
    const total = w * h;

    const matchesAt = (ax: number, ay: number): boolean => {
        const ai = (ay * actual.width + ax) * 4;
        for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            const gy = ay + dy;
            if (gy < 0 || gy >= h) {
                continue;
            }
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const gx = ax + dx;
                if (gx < 0 || gx >= w) {
                    continue;
                }
                const gi = (gy * golden.width + gx) * 4;
                let pixMax = 0;
                for (let c = 0; c < 3; c++) {
                    const d = Math.abs(actual.data[ai + c]! - golden.data[gi + c]!);
                    if (d > pixMax) {
                        pixMax = d;
                    }
                }
                if (pixMax <= perChannelTolerance) {
                    return true;
                }
            }
        }
        return false;
    };

    let mismatch = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!matchesAt(x, y)) {
                mismatch++;
            }
        }
    }
    return { mismatchFraction: total > 0 ? mismatch / total : 0, totalPixels: total };
}

/**
 * Compares a rendered PNG to a committed golden, regenerating the golden when
 * `UPDATE_AUDIO_GOLDENS=1` (or when it does not yet exist).
 *
 * The diff is position-tolerant (see {@link comparePngBuffers}): combined with
 * the thick waveform band, this absorbs the sub-pixel envelope shifts that a
 * native renderer can produce across platforms, so the golden test does not
 * fail on cosmetic 1–2 px wobble.
 * @param name - Golden file name (without extension).
 * @param pngBuffer - The freshly rendered PNG bytes.
 * @param perChannelTolerance - Allowed per-channel byte diff. Defaults to `8`.
 * @param searchRadius - Position tolerance in pixels. Defaults to `2`.
 * @returns The comparison outcome.
 */
export function compareToGolden(name: string, pngBuffer: Buffer, perChannelTolerance = 8, searchRadius = 2): GoldenComparison {
    const goldenPath = join(AUDIO_GOLDEN_DIR, `${name}.png`);
    const update = process.env.UPDATE_AUDIO_GOLDENS === "1";

    if (update || !existsSync(goldenPath)) {
        mkdirSync(AUDIO_GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, pngBuffer);
        return { updated: true, mismatchFraction: 0, totalPixels: 0 };
    }

    const { mismatchFraction, totalPixels } = comparePngBuffers(pngBuffer, readFileSync(goldenPath), perChannelTolerance, searchRadius);
    return { updated: false, mismatchFraction, totalPixels };
}
