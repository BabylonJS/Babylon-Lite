import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext } from "./web-audio-mock.js";
import type { MockGainNode, MockAudioBufferSourceNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import {
    createSoundAsync,
    playSound,
    pauseSound,
    resumeSound,
    stopSound,
    disposeSound,
    setSoundVolume,
    SoundState,
} from "../../../../packages/babylon-lite/src/audio/static-sound.js";
import type { AudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import type { StaticSound, SoundInstance } from "../../../../packages/babylon-lite/src/audio/static-sound.js";

function newest(sound: StaticSound): SoundInstance {
    const instance = sound._newest;
    if (!instance) {
        throw new Error("No newest instance");
    }
    return instance;
}

describe("static-sound", () => {
    let engine: AudioEngine;
    let ctx: MockAudioContext;

    beforeEach(async () => {
        installWebAudioMock();
        ctx = new MockAudioContext();
        engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
    });

    afterEach(() => {
        disposeAudioEngine(engine);
        uninstallWebAudioMock();
    });

    it("creates a sound routed to the default main bus", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        const graphOut = sound._graph._volume as unknown as MockGainNode;
        expect(graphOut.connections.has(engine._mainBus._volume as never)).toBe(true);
        expect(sound.state).toBe(SoundState.Stopped);
        disposeSound(sound);
    });

    it("plays a sound, wiring source -> instance volume -> sub-graph", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        playSound(sound);

        expect(sound.state).toBe(SoundState.Started);
        const instance = newest(sound);
        const source = instance._sourceNode as unknown as MockAudioBufferSourceNode;
        const volume = instance._volumeNode as unknown as MockGainNode;

        expect(source.started).not.toBeNull();
        expect(source.connections.has(volume as never)).toBe(true);
        expect(volume.connections.has(sound._graph._volume as never)).toBe(true);
        disposeSound(sound);
    });

    it("transitions to Stopped and fires onEnded when the source ends", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        let ended = false;
        sound.onEnded.add(() => (ended = true));
        playSound(sound);

        const source = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        source.fireEnded();

        expect(ended).toBe(true);
        expect(sound.state).toBe(SoundState.Stopped);
        expect(sound.instanceCount).toBe(0);
        disposeSound(sound);
    });

    it("stops a playing sound", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        playSound(sound);
        const source = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        stopSound(sound);
        expect(source.stopped).not.toBeNull();
        expect(sound.state).toBe(SoundState.Stopped);
        disposeSound(sound);
    });

    it("pauses and resumes a sound", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        playSound(sound);
        const instance = newest(sound);

        ctx.currentTime = 0.5;
        pauseSound(sound);
        expect(sound.state).toBe(SoundState.Paused);
        expect(instance._state).toBe(SoundState.Paused);
        expect(instance._enginePauseTime).toBeCloseTo(0.5);

        resumeSound(sound);
        expect(sound.state).toBe(SoundState.Started);
        disposeSound(sound);
    });

    it("honours maxInstances by stopping the oldest", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { maxInstances: 1 });
        playSound(sound);
        const first = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        playSound(sound);
        expect(first.stopped).not.toBeNull();
        disposeSound(sound);
    });

    it("sets the sub-graph volume", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        setSoundVolume(sound, 0.3, { shape: "none" });
        const graphVolume = sound._graph._volume as unknown as MockGainNode;
        expect(graphVolume.gain.value).toBe(0.3);
        disposeSound(sound);
    });

    it("autoplays when requested", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { autoplay: true });
        expect(sound.state).toBe(SoundState.Started);
        expect(sound.instanceCount).toBe(1);
        disposeSound(sound);
    });

    it("applies pitch and playbackRate to the source node", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { pitch: 600, playbackRate: 1.5 });
        playSound(sound);
        const source = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        expect(source.detune.value).toBe(600);
        expect(source.playbackRate.value).toBe(1.5);
        disposeSound(sound);
    });

    it("overrides pitch and playbackRate per play, falling back to the sound defaults", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { pitch: 600, playbackRate: 1.5 });
        // Explicit per-play values win over the sound-level defaults.
        playSound(sound, { pitch: -200, playbackRate: 0.8 });
        const overridden = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        expect(overridden.detune.value).toBe(-200);
        expect(overridden.playbackRate.value).toBe(0.8);
        // A play with no overrides falls back to the sound-level defaults.
        playSound(sound);
        const defaulted = newest(sound)._sourceNode as unknown as MockAudioBufferSourceNode;
        expect(defaulted.detune.value).toBe(600);
        expect(defaulted.playbackRate.value).toBe(1.5);
        disposeSound(sound);
    });

    it("preserves per-play pitch/playbackRate overrides across pause and resume", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { pitch: 600, playbackRate: 1.5 });
        playSound(sound, { pitch: -200, playbackRate: 0.8 });
        const instance = newest(sound);

        ctx.currentTime = 0.5;
        pauseSound(sound);
        expect(instance._state).toBe(SoundState.Paused);

        // Resuming with no options re-inits the source node from the retained per-instance overrides.
        resumeSound(sound);
        const resumed = instance._sourceNode as unknown as MockAudioBufferSourceNode;
        expect(resumed.detune.value).toBe(-200);
        expect(resumed.playbackRate.value).toBe(0.8);
        disposeSound(sound);
    });

    it("preserves per-play pitch/playbackRate overrides through the engine-state-change restart", async () => {
        // A looping sound started while the engine is suspended defers to Starting and restarts on resume.
        ctx._setState("suspended");
        const sound = await createSoundAsync(engine, new ArrayBuffer(8), { pitch: 600, playbackRate: 1.5 });
        playSound(sound, { loop: true, pitch: -200, playbackRate: 0.8 });
        const instance = newest(sound);
        expect(instance._state).toBe(SoundState.Starting);

        // Engine becomes running -> `_onEngineStateChanged` restarts the instance with the retained overrides.
        ctx._setState("running");
        const started = instance._sourceNode as unknown as MockAudioBufferSourceNode;
        expect(instance._state).toBe(SoundState.Started);
        expect(started.detune.value).toBe(-200);
        expect(started.playbackRate.value).toBe(0.8);
        disposeSound(sound);
    });

    it("is removed from the engine on dispose", async () => {
        const sound = await createSoundAsync(engine, new ArrayBuffer(8));
        expect(engine._sounds.has(sound)).toBe(true);
        disposeSound(sound);
        expect(engine._sounds.has(sound)).toBe(false);
    });
});
