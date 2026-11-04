/**
 * Tier-3 golden visual tests.
 *
 * Renders known sounds offline, rasterizes the PCM to a deterministic waveform
 * PNG, and golden-diffs it. Self-skips when `node-web-audio-api` is
 * unavailable. Regenerate goldens with `UPDATE_AUDIO_GOLDENS=1`.
 */

import { describe, expect, it } from "vitest";
import { createSoundAsync, enableStereo, playSound, setStereoPan } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, realWebAudioAvailable, renderOffline } from "../_shared/real-web-audio.js";
import { compareToGolden, renderWaveformPng } from "../_shared/waveform-png.js";

const MAX_MISMATCH_FRACTION = 0.005;

describe.skipIf(!realWebAudioAvailable)("Tier-3 golden waveform", () => {
    it("matches the golden for a 220 Hz sine", async () => {
        const result = await renderOffline({
            seconds: 0.05,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 220, 0.05, 0.8);
                const sound = await createSoundAsync(engine, buffer);
                playSound(sound);
            },
        });

        const png = renderWaveformPng(result.mono);
        const cmp = compareToGolden("sine-220hz", png);
        if (cmp.updated) {
            return;
        }
        expect(cmp.mismatchFraction).toBeLessThan(MAX_MISMATCH_FRACTION);
    });

    it("matches the golden for a linear fade-in envelope", async () => {
        const result = await renderOffline({
            seconds: 0.2,
            channels: 1,
            setup: async (engine, ctx) => {
                // A tone whose amplitude rises linearly across the buffer.
                const sampleRate = ctx.sampleRate;
                const length = Math.ceil(0.2 * sampleRate);
                const buffer = ctx.createBuffer(1, length, sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < length; i++) {
                    const env = i / length;
                    data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.9 * env;
                }
                const sound = await createSoundAsync(engine, buffer);
                playSound(sound);
            },
        });

        const png = renderWaveformPng(result.mono);
        const cmp = compareToGolden("fade-in-envelope", png);
        if (cmp.updated) {
            return;
        }
        expect(cmp.mismatchFraction).toBeLessThan(MAX_MISMATCH_FRACTION);
    });

    it("matches the golden for a hard-left stereo tone (right channel silent)", async () => {
        const result = await renderOffline({
            seconds: 0.05,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 330, 0.05, 0.8);
                const sound = await createSoundAsync(engine, buffer);
                enableStereo(sound);
                setStereoPan(sound, -1);
                playSound(sound);
            },
        });

        const left = renderWaveformPng(result.left);
        const right = renderWaveformPng(result.right);
        const leftCmp = compareToGolden("stereo-left-L", left);
        const rightCmp = compareToGolden("stereo-left-R", right);
        if (leftCmp.updated || rightCmp.updated) {
            return;
        }
        expect(leftCmp.mismatchFraction).toBeLessThan(MAX_MISMATCH_FRACTION);
        expect(rightCmp.mismatchFraction).toBeLessThan(MAX_MISMATCH_FRACTION);
    });
});
