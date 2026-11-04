import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext, MockAudioBuffer } from "./web-audio-mock.js";
import { createSoundBufferAsync } from "../../../../packages/babylon-lite/src/audio/sound-buffer.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import type { AudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";

describe("sound-buffer", () => {
    let engine: AudioEngine;
    let ctx: MockAudioContext;
    let savedFetch: typeof globalThis.fetch;

    beforeEach(async () => {
        installWebAudioMock();
        savedFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({ ok: true, status: 200, statusText: "OK", arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof globalThis.fetch;
        ctx = new MockAudioContext();
        engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
    });

    afterEach(() => {
        disposeAudioEngine(engine);
        globalThis.fetch = savedFetch;
        uninstallWebAudioMock();
    });

    it("decodes an ArrayBuffer", async () => {
        const buffer = await createSoundBufferAsync(engine, new ArrayBuffer(16));
        expect(buffer.duration).toBe(1);
        expect(buffer.sampleRate).toBe(48000);
        expect(buffer.channelCount).toBe(2);
    });

    it("passes an existing AudioBuffer through", async () => {
        const audioBuffer = new MockAudioBuffer(2, 44100, 1, 88200);
        const buffer = await createSoundBufferAsync(engine, audioBuffer as unknown as AudioBuffer);
        expect(buffer.duration).toBe(2);
        expect(buffer.sampleRate).toBe(44100);
        expect(buffer.channelCount).toBe(1);
    });

    it("decodes from a single URL", async () => {
        const buffer = await createSoundBufferAsync(engine, "sound.mp3");
        expect(buffer.duration).toBe(1);
    });

    it("selects the first decodable URL from a list", async () => {
        const buffer = await createSoundBufferAsync(engine, ["sound.ogg", "sound.mp3"]);
        expect(buffer.duration).toBe(1);
    });
});
