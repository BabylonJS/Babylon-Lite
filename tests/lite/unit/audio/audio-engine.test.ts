import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext, MockOfflineAudioContext } from "./web-audio-mock.js";
import type { MockGainNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine, setMasterVolume, getMasterVolume } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";

describe("audio-engine", () => {
    beforeEach(() => installWebAudioMock());
    afterEach(() => uninstallWebAudioMock());

    it("creates an engine with a main out connected to the destination", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        const mainOutGain = engine._mainOut._gain as unknown as MockGainNode;
        const mainBusVolume = engine._mainBus._volume as unknown as MockGainNode;
        expect(mainOutGain.connections.has(ctx.destination as never)).toBe(true);
        expect(mainBusVolume.connections.has(engine._mainOut._gain as never)).toBe(true);
        disposeAudioEngine(engine);
    });

    it("reports running state for a real-time context", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        expect(engine.state).toBe("running");
        disposeAudioEngine(engine);
    });

    it("treats OfflineAudioContext as always running", async () => {
        const ctx = new MockOfflineAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        expect(engine._isOffline).toBe(true);
        expect(engine.state).toBe("running");
        disposeAudioEngine(engine);
    });

    it("applies the initial master volume", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext, volume: 0.25 });
        expect(getMasterVolume(engine)).toBe(0.25);
        disposeAudioEngine(engine);
    });

    it("ramps the master volume", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        setMasterVolume(engine, 0.5, { shape: "none" });
        expect(engine._mainOut._gain.gain.value).toBe(0.5);
        disposeAudioEngine(engine);
    });

    it("emits onStateChanged when the context state changes", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        const states: string[] = [];
        engine.onStateChanged.add((s) => states.push(s));
        ctx._setState("suspended");
        expect(states).toContain("suspended");
        disposeAudioEngine(engine);
    });

    it("removes the statechange listener on dispose", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        expect(ctx.stateListeners.length).toBeGreaterThan(0);
        disposeAudioEngine(engine);
        expect(ctx.stateListeners.length).toBe(0);
    });

    it("closes a real-time context on dispose", async () => {
        const ctx = new MockAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        disposeAudioEngine(engine);
        expect(ctx.state).toBe("closed");
    });

    it("does not close an offline context on dispose", async () => {
        const ctx = new MockOfflineAudioContext();
        const engine = await createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
        disposeAudioEngine(engine);
        // MockOfflineAudioContext has no `state` / `close`; absence of a throw is the assertion.
        expect(engine._isOffline).toBe(true);
    });
});
