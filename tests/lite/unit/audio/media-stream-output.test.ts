import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createAudioEngineMediaStream, disposeAudioEngineMediaStream } from "../../../../packages/babylon-lite/src/audio/media-stream-output.js";
import { installWebAudioMock, MockAudioContext, MockOfflineAudioContext, uninstallWebAudioMock } from "./web-audio-mock.js";
import type { MockGainNode } from "./web-audio-mock.js";

describe("media-stream-output", () => {
    beforeEach(() => installWebAudioMock());
    afterEach(() => uninstallWebAudioMock());

    it("mirrors the post-master output without disconnecting the speaker destination", async () => {
        const context = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: context as unknown as BaseAudioContext });
        const output = createAudioEngineMediaStream(engine);
        const destination = context.mediaStreamDestinations[0]!;
        const mainOut = engine._mainOut._gain as unknown as MockGainNode;

        expect(output.stream).toBe(destination.stream);
        expect(mainOut.connections.has(context.destination as never)).toBe(true);
        expect(mainOut.connections.has(destination as never)).toBe(true);

        disposeAudioEngineMediaStream(output);
        disposeAudioEngine(engine);
    });

    it("disconnects and stops its tracks exactly once", async () => {
        const context = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: context as unknown as BaseAudioContext });
        const output = createAudioEngineMediaStream(engine);
        const destination = context.mediaStreamDestinations[0]!;
        const mainOut = engine._mainOut._gain as unknown as MockGainNode;
        const track = destination.stream.tracks[0]!;

        expect(engine._disposers).toContain(output._engineDisposer);
        disposeAudioEngineMediaStream(output);
        disposeAudioEngineMediaStream(output);

        expect(mainOut.connections.has(destination as never)).toBe(false);
        expect(track.stopped).toBe(true);
        expect(engine._disposers).not.toContain(output._engineDisposer);

        disposeAudioEngine(engine);
    });

    it("stops every registered output when the engine is disposed", async () => {
        const context = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: context as unknown as BaseAudioContext });
        createAudioEngineMediaStream(engine);
        createAudioEngineMediaStream(engine);
        const tracks = context.mediaStreamDestinations.map((destination) => destination.stream.tracks[0]!);

        disposeAudioEngine(engine);

        expect(tracks.every((track) => track.stopped)).toBe(true);
    });

    it("rejects offline audio contexts", async () => {
        const context = new MockOfflineAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: context as unknown as BaseAudioContext });

        expect(() => createAudioEngineMediaStream(engine)).toThrow("Audio engine media streams require a real-time AudioContext.");

        disposeAudioEngine(engine);
    });
});
