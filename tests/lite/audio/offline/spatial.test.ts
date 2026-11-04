/**
 * Tier-2 offline PCM tests — spatial (3D) audio.
 *
 * Renders a tone through the spatial panner and asserts inter-channel level
 * (left/right placement) and distance attenuation. Self-skips when
 * `node-web-audio-api` is unavailable.
 */

import { describe, expect, it } from "vitest";
import { createSoundAsync, enableSpatial, playSound } from "../../../../packages/babylon-lite/src/audio/index.js";
import { makeSineBuffer, realWebAudioAvailable, renderOffline, rms } from "../_shared/real-web-audio.js";

describe.skipIf(!realWebAudioAvailable)("Tier-2 offline PCM — spatial audio", () => {
    it("places a source to the right in the right channel", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                enableSpatial(sound, { position: { x: 5, y: 0, z: 0 } });
                playSound(sound);
            },
        });

        const left = rms(result.left);
        const right = rms(result.right);
        expect(right).toBeGreaterThan(left);
    });

    it("places a source to the left in the left channel", async () => {
        const result = await renderOffline({
            seconds: 0.3,
            channels: 2,
            setup: async (engine, ctx) => {
                const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                const sound = await createSoundAsync(engine, buffer);
                enableSpatial(sound, { position: { x: -5, y: 0, z: 0 } });
                playSound(sound);
            },
        });

        const left = rms(result.left);
        const right = rms(result.right);
        expect(left).toBeGreaterThan(right);
    });

    it("attenuates a distant source (linear distance model)", async () => {
        const renderAt = (z: number) =>
            renderOffline({
                seconds: 0.3,
                channels: 2,
                setup: async (engine, ctx) => {
                    const buffer = makeSineBuffer(ctx, 440, 0.3, 0.5);
                    const sound = await createSoundAsync(engine, buffer);
                    enableSpatial(sound, {
                        position: { x: 0, y: 0, z },
                        distanceModel: "linear",
                        minDistance: 1,
                        maxDistance: 10000,
                        rolloffFactor: 1,
                    });
                    playSound(sound);
                },
            });

        const near = await renderAt(1);
        const far = await renderAt(5000);
        const nearEnergy = rms(near.left) + rms(near.right);
        const farEnergy = rms(far.left) + rms(far.right);
        expect(nearEnergy).toBeGreaterThan(farEnergy);
        // Linear model at d=5000 (max 10000) ≈ 0.5 gain → roughly half energy.
        expect(farEnergy).toBeLessThan(nearEnergy * 0.75);
    });
});
