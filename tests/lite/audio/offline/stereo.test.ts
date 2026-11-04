/**
 * Tier-2 offline PCM tests — stereo panning.
 *
 * Renders a mono tone through the stereo panner and asserts the inter-channel
 * energy split matches the pan. Self-skips when `node-web-audio-api` is
 * unavailable.
 */

import { describe, expect, it } from "vitest";
import { createSoundAsync, enableStereo, playSound, setStereoPan } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, realWebAudioAvailable, renderOffline, rms, rmsWindow } from "../_shared/real-web-audio.js";

describe.skipIf(!realWebAudioAvailable)("Tier-2 offline PCM — stereo panning", () => {
    it("sends a hard-left pan to the left channel only", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                enableStereo(sound);
                setStereoPan(sound, -1);
                playSound(sound);
            },
        });

        // Measure after the default pan ramp (~0.01 s) has settled.
        const left = rmsWindow(result.left, result.sampleRate, 0.05, 0.3);
        const right = rmsWindow(result.right, result.sampleRate, 0.05, 0.3);
        expect(left).toBeGreaterThan(0.2);
        expect(right).toBeLessThan(1e-3);
    });

    it("sends a hard-right pan to the right channel only", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                enableStereo(sound);
                setStereoPan(sound, 1);
                playSound(sound);
            },
        });

        const left = rmsWindow(result.left, result.sampleRate, 0.05, 0.3);
        const right = rmsWindow(result.right, result.sampleRate, 0.05, 0.3);
        expect(right).toBeGreaterThan(0.2);
        expect(left).toBeLessThan(1e-3);
    });

    it("splits a centered pan roughly evenly", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                enableStereo(sound);
                setStereoPan(sound, 0);
                playSound(sound);
            },
        });

        const left = rms(result.left);
        const right = rms(result.right);
        expect(left).toBeGreaterThan(0.1);
        expect(right).toBeGreaterThan(0.1);
        expect(Math.abs(left - right)).toBeLessThan(0.02);
    });
});
