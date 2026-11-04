/**
 * Tier-2 offline PCM tests — volume ramps.
 *
 * Renders a tone whose volume is ramped over time and asserts the PCM envelope
 * follows the ramp. Self-skips when `node-web-audio-api` is unavailable.
 */

import { describe, expect, it } from "vitest";
import { createSoundAsync, playSound, setSoundVolume } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, realWebAudioAvailable, renderOffline, rmsWindow } from "../_shared/real-web-audio.js";

describe.skipIf(!realWebAudioAvailable)("Tier-2 offline PCM — volume ramps", () => {
    it("follows a linear fade-in", async () => {
        const result = await renderOffline({
            seconds: 0.6,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.6, 0.5);
                const sound = await createSoundAsync(engine, buffer, { volume: 0.05 });
                playSound(sound);
                setSoundVolume(sound, 1, { shape: "linear", duration: 0.5 });
            },
        });

        const mono = result.mono;
        const sr = result.sampleRate;
        const early = rmsWindow(mono, sr, 0.0, 0.1);
        const mid = rmsWindow(mono, sr, 0.2, 0.3);
        const late = rmsWindow(mono, sr, 0.4, 0.5);
        // Monotonic rise across the ramp.
        expect(mid).toBeGreaterThan(early);
        expect(late).toBeGreaterThan(mid);
    });

    it("follows a linear fade-out", async () => {
        const result = await renderOffline({
            seconds: 0.6,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.6, 0.5);
                const sound = await createSoundAsync(engine, buffer, { volume: 1 });
                playSound(sound);
                setSoundVolume(sound, 0.01, { shape: "linear", duration: 0.5 });
            },
        });

        const mono = result.mono;
        const sr = result.sampleRate;
        const early = rmsWindow(mono, sr, 0.0, 0.1);
        const late = rmsWindow(mono, sr, 0.4, 0.5);
        // Monotonic fall across the ramp.
        expect(late).toBeLessThan(early);
        expect(late).toBeLessThan(0.1);
    });
});
