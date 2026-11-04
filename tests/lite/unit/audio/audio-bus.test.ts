import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext, MockAudioBuffer } from "./web-audio-mock.js";
import type { MockGainNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createAudioBusAsync, disposeAudioBus, setBusVolume } from "../../../../packages/babylon-lite/src/audio/audio-bus.js";
import { createSoundAsync } from "../../../../packages/babylon-lite/src/audio/static-sound.js";

const asGain = (node: unknown) => node as unknown as MockGainNode;

async function makeEngine() {
    const ctx = new MockAudioContext();
    const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
    return engine;
}

describe("audio-bus", () => {
    beforeEach(() => installWebAudioMock());
    afterEach(() => uninstallWebAudioMock());

    it("routes a new bus into the engine's default main bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "music");
        expect(bus.name).toBe("music");
        // bus volume output connects to the main bus input (its volume node).
        expect(asGain(bus._graph._volume).connections.has(asGain(engine._mainBus._volume))).toBe(true);
        disposeAudioEngine(engine);
    });

    it("applies the initial bus volume", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "sfx", { volume: 0.3 });
        expect(asGain(bus._graph._volume).gain.value).toBe(0.3);
        disposeAudioEngine(engine);
    });

    it("sets a bus volume immediately with shape none", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "sfx");
        setBusVolume(bus, 0.5, { shape: "none" });
        expect(asGain(bus._graph._volume).gain.value).toBe(0.5);
        disposeAudioEngine(engine);
    });

    it("sets the main bus volume via setBusVolume", async () => {
        const engine = await makeEngine();
        setBusVolume(engine._mainBus, 0.42, { shape: "none" });
        expect(asGain(engine._mainBus._volume).gain.value).toBe(0.42);
        disposeAudioEngine(engine);
    });

    it("routes a sound to a custom output bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "music");
        const sound = await createSoundAsync(engine, new MockAudioBuffer() as unknown as AudioBuffer, { outBus: bus });
        // The sound's sub-graph output feeds the bus input, not the main bus.
        expect(asGain(sound._graph._volume).connections.has(asGain(bus._graph._volume))).toBe(true);
        expect(asGain(sound._graph._volume).connections.has(asGain(engine._mainBus._volume))).toBe(false);
        disposeAudioEngine(engine);
    });

    it("chains a bus into another bus", async () => {
        const engine = await makeEngine();
        const parent = await createAudioBusAsync(engine, "parent");
        const child = await createAudioBusAsync(engine, "child", { outBus: parent });
        expect(asGain(child._graph._volume).connections.has(asGain(parent._graph._volume))).toBe(true);
        disposeAudioEngine(engine);
    });

    it("disconnects and untracks a bus on dispose", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "music");
        expect(engine._buses.has(bus as never)).toBe(true);
        disposeAudioBus(bus);
        expect(engine._buses.has(bus as never)).toBe(false);
        expect(asGain(bus._graph._volume).connections.size).toBe(0);
        disposeAudioEngine(engine);
    });

    it("disposes all buses when the engine is disposed", async () => {
        const engine = await makeEngine();
        const a = await createAudioBusAsync(engine, "a");
        const b = await createAudioBusAsync(engine, "b");
        disposeAudioEngine(engine);
        expect(engine._buses.size).toBe(0);
        expect(asGain(a._graph._volume).connections.size).toBe(0);
        expect(asGain(b._graph._volume).connections.size).toBe(0);
    });
});
