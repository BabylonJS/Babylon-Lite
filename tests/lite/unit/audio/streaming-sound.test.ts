import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    installWebAudioMock,
    uninstallWebAudioMock,
    installStreamingMocks,
    uninstallStreamingMocks,
    MockAudioContext,
    MockOfflineAudioContext,
    MockMediaElement,
} from "./web-audio-mock.js";
import type { MockGainNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createAudioBusAsync } from "../../../../packages/babylon-lite/src/audio/audio-bus.js";
import { SoundState } from "../../../../packages/babylon-lite/src/audio/static-sound.js";
import {
    createStreamingSoundAsync,
    preloadStreamingInstanceAsync,
    playStreamingSound,
    pauseStreamingSound,
    resumeStreamingSound,
    stopStreamingSound,
    disposeStreamingSound,
} from "../../../../packages/babylon-lite/src/audio/streaming-sound.js";

const asGain = (node: unknown) => node as unknown as MockGainNode;
const media = (el: unknown) => el as unknown as MockMediaElement;

async function makeEngine() {
    const ctx = new MockAudioContext();
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

describe("streaming-sound", () => {
    beforeEach(() => {
        installWebAudioMock();
        installStreamingMocks();
    });
    afterEach(() => {
        uninstallStreamingMocks();
        uninstallWebAudioMock();
    });

    it("creates a streaming sound from a URL and routes it to the main bus", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        expect(sound.preloadCompletedCount).toBe(1);
        const instance = sound._preloaded[0]!;
        // Instance volume node feeds the sound sub-graph input.
        expect(asGain(instance._volumeNode).connections.has(asGain(sound._graph._volume))).toBe(true);
        // Sound sub-graph feeds the main bus.
        expect(asGain(sound._graph._volume).connections.has(asGain(engine._mainBus._volume))).toBe(true);
        expect(media(instance._mediaElement).src).toBe("music.mp3");
        disposeAudioEngine(engine);
    });

    it("rejects on an offline context", async () => {
        const ctx = new MockOfflineAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        await expect(createStreamingSoundAsync(engine, "music.mp3")).rejects.toThrow(/real-time AudioContext/);
        disposeAudioEngine(engine);
    });

    it("releases the sound graph when initial preloading fails", async () => {
        class FailingMediaElement extends MockMediaElement {
            public override load(): void {
                this.loaded = true;
                queueMicrotask(() => this.fire("error"));
            }
        }
        (globalThis as unknown as { Audio: typeof MockMediaElement }).Audio = FailingMediaElement;
        const engine = await makeEngine();

        await expect(createStreamingSoundAsync(engine, "missing.mp3")).rejects.toBeUndefined();

        expect(engine._sounds.size).toBe(0);
        disposeAudioEngine(engine);
    });

    it("builds a multi-source element from a URL list", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, ["a.ogg", "b.mp3"]);
        const el = media(sound._preloaded[0]!._mediaElement);
        expect(el.children.map((c) => c.src)).toEqual(["a.ogg", "b.mp3"]);
        disposeAudioEngine(engine);
    });

    it("preloads instances on demand", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3", { preloadCount: 0 });
        expect(sound.preloadCompletedCount).toBe(0);
        await preloadStreamingInstanceAsync(sound);
        expect(sound.preloadCompletedCount).toBe(1);
        disposeAudioEngine(engine);
    });

    it("plays a preloaded instance", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        playStreamingSound(sound);
        expect(sound.instanceCount).toBe(1);
        expect(sound.state).toBe(SoundState.Started);
        expect(sound.preloadCompletedCount).toBe(0);
        disposeAudioEngine(engine);
    });

    it("routes a streaming sound to a custom output bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "music");
        const sound = await createStreamingSoundAsync(engine, "music.mp3", { outBus: bus });
        expect(asGain(sound._graph._volume).connections.has(asGain(bus._graph._volume))).toBe(true);
        expect(asGain(sound._graph._volume).connections.has(asGain(engine._mainBus._volume))).toBe(false);
        disposeAudioEngine(engine);
    });

    it("pauses and resumes", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        playStreamingSound(sound);
        const instance = Array.from(sound._instances)[0]!;
        pauseStreamingSound(sound);
        expect(sound.state).toBe(SoundState.Paused);
        expect(media(instance._mediaElement).paused).toBe(true);
        resumeStreamingSound(sound);
        expect(sound.state).toBe(SoundState.Started);
        expect(media(instance._mediaElement).playing).toBe(true);
        disposeAudioEngine(engine);
    });

    it("fires onEnded when stopped", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        let ended = false;
        sound.onEnded.add(() => (ended = true));
        playStreamingSound(sound);
        stopStreamingSound(sound);
        expect(ended).toBe(true);
        expect(sound.instanceCount).toBe(0);
        expect(sound.state).toBe(SoundState.Stopped);
        disposeAudioEngine(engine);
    });

    it("respects maxInstances", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3", { preloadCount: 2, maxInstances: 1 });
        playStreamingSound(sound);
        playStreamingSound(sound);
        expect(sound.instanceCount).toBe(1);
        disposeAudioEngine(engine);
    });

    it("disposes cleanly and untracks from the engine", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        expect(engine._sounds.has(sound as never)).toBe(true);
        disposeStreamingSound(sound);
        expect(engine._sounds.has(sound as never)).toBe(false);
        expect(sound.preloadCompletedCount).toBe(0);
        expect(asGain(sound._graph._volume).connections.size).toBe(0);
        disposeAudioEngine(engine);
    });

    it("is stopped when the engine is disposed", async () => {
        const engine = await makeEngine();
        const sound = await createStreamingSoundAsync(engine, "music.mp3");
        playStreamingSound(sound);
        disposeAudioEngine(engine);
        expect(engine._sounds.size).toBe(0);
        expect(sound.instanceCount).toBe(0);
    });
});
