/**
 * Tier-2 offline PCM tests — playback fundamentals.
 *
 * Renders a known sine tone through the real engine + `OfflineAudioContext`
 * and asserts on the resulting PCM (peak, RMS, silence windows, loop repeat,
 * start-offset shift). Self-skips when `node-web-audio-api` is unavailable.
 */

import { describe, expect, it } from "vitest";
import { createSoundAsync, playSound } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, peak, realWebAudioAvailable, renderOffline, rms, rmsWindow } from "../_shared/real-web-audio.js";

describe.skipIf(!realWebAudioAvailable)("Tier-2 offline PCM — playback", () => {
    it("renders a 440 Hz sine at the expected peak and RMS", async () => {
        const result = await renderOffline({
            seconds: 0.5,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.5, 0.5);
                const sound = await createSoundAsync(engine, buffer, { volume: 1 });
                playSound(sound);
            },
        });

        const mono = result.mono;
        // A 0.5-amplitude sine has peak ≈ 0.5 and RMS ≈ 0.5 / √2 ≈ 0.3536.
        expect(peak(mono)).toBeGreaterThan(0.45);
        expect(peak(mono)).toBeLessThanOrEqual(0.5 + 1e-3);
        expect(rms(mono)).toBeCloseTo(0.3536, 2);
    });

    it("scales output by the sound volume", async () => {
        const render = (volume: number) =>
            renderOffline({
                seconds: 0.3,
                channels: 1,
                setup: async (engine, ctx) => {
                    const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                    const sound = await createSoundAsync(engine, buffer, { volume });
                    playSound(sound);
                },
            });

        const full = await render(1);
        const half = await render(0.5);
        const ratio = rms(half.mono) / rms(full.mono);
        expect(ratio).toBeCloseTo(0.5, 1);
    });

    it("plays only for the buffer duration, leaving later samples silent", async () => {
        const result = await renderOffline({
            seconds: 1.0,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.25, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                playSound(sound);
            },
        });

        const mono = result.mono;
        const sr = result.sampleRate;
        // Energy in the first 0.25 s, silence well after the buffer ends.
        expect(rmsWindow(mono, sr, 0.0, 0.2)).toBeGreaterThan(0.2);
        expect(rmsWindow(mono, sr, 0.5, 1.0)).toBeLessThan(1e-4);
    });

    it("repeats the tone when looping", async () => {
        const result = await renderOffline({
            seconds: 1.0,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.2, 0.5);
                const sound = await createSoundAsync(engine, buffer, { loop: true });
                playSound(sound);
            },
        });

        const mono = result.mono;
        const sr = result.sampleRate;
        // With looping, the window after the first buffer length still has energy.
        expect(rmsWindow(mono, sr, 0.0, 0.2)).toBeGreaterThan(0.2);
        expect(rmsWindow(mono, sr, 0.6, 0.8)).toBeGreaterThan(0.2);
    });

    it("shifts playback by the start offset", async () => {
        // The buffer is silent for its first 0.2 s, then a tone. With a 0.2 s
        // start offset the output should begin with the tone immediately.
        const buildBuffer = (ctx: BaseAudioContext) => {
            const sampleRate = ctx.sampleRate;
            const length = Math.ceil(0.4 * sampleRate);
            const buffer = ctx.createBuffer(1, length, sampleRate);
            const data = buffer.getChannelData(0);
            const toneStart = Math.floor(0.2 * sampleRate);
            for (let i = toneStart; i < length; i++) {
                data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
            }
            return buffer;
        };

        const withoutOffset = await renderOffline({
            seconds: 0.1,
            channels: 1,
            setup: async (engine, ctx) => {
                const sound = await createSoundAsync(engine, buildBuffer(ctx));
                playSound(sound);
            },
        });
        const withOffset = await renderOffline({
            seconds: 0.1,
            channels: 1,
            setup: async (engine, ctx) => {
                const sound = await createSoundAsync(engine, buildBuffer(ctx), { startOffset: 0.2 });
                playSound(sound);
            },
        });

        // First 0.1 s is silent without offset, but the tone with the offset.
        expect(rms(withoutOffset.mono)).toBeLessThan(1e-4);
        expect(rms(withOffset.mono)).toBeGreaterThan(0.2);
    });
});
