/**
 * Tier-2 offline PCM tests — bus routing.
 *
 * Renders a tone through an intermediate audio bus and asserts the bus volume
 * attenuates the summed output. Self-skips when `node-web-audio-api` is
 * unavailable.
 */

import { describe, expect, it } from "vitest";
import { createAudioBusAsync, createSoundAsync, playSound, setBusVolume } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, realWebAudioAvailable, renderOffline, rms } from "../_shared/real-web-audio.js";

describe.skipIf(!realWebAudioAvailable)("Tier-2 offline PCM — bus routing", () => {
    it("attenuates output by the bus volume", async () => {
        const renderThroughBus = (busVolume: number) =>
            renderOffline({
                seconds: 0.3,
                channels: 1,
                setup: async (engine, ctx) => {
                    const bus = await createAudioBusAsync(engine, "fx", { volume: busVolume });
                    const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                    const sound = await createSoundAsync(engine, buffer, { outBus: bus, volume: 1 });
                    playSound(sound);
                },
            });

        const full = await renderThroughBus(1);
        const half = await renderThroughBus(0.5);
        const ratio = rms(half.mono) / rms(full.mono);
        expect(ratio).toBeCloseTo(0.5, 1);
    });

    it("applies a bus volume change set after creation", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 1,
            setup: async (engine, ctx) => {
                const bus = await createAudioBusAsync(engine, "fx");
                setBusVolume(bus, 0.25);
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer, { outBus: bus, volume: 1 });
                playSound(sound);
            },
        });

        const direct = await renderOffline({
            seconds: 0.3,
            channels: 1,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer, { volume: 1 });
                playSound(sound);
            },
        });

        const ratio = rms(result.mono) / rms(direct.mono);
        expect(ratio).toBeCloseTo(0.25, 1);
    });
});
