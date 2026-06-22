import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, installMicrophoneMocks, uninstallMicrophoneMocks, MockAudioContext, MockMediaStream } from "./web-audio-mock.js";
import type { MockGainNode, MockMediaStreamAudioSourceNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createSoundSourceAsync, createMicrophoneSoundSourceAsync, setSoundSourceVolume, disposeSoundSource } from "../../../../packages/babylon-lite/src/audio/sound-source.js";
import { enableSpatial, type SpatialSubNode } from "../../../../packages/babylon-lite/src/audio/spatial.js";
import { enableStereo, type StereoSubNode } from "../../../../packages/babylon-lite/src/audio/stereo.js";
import { enableAnalyzer } from "../../../../packages/babylon-lite/src/audio/analyzer.js";
import type { AudioGraphHost } from "../../../../packages/babylon-lite/src/audio/host-types.js";

const asAudioNode = (node: unknown) => node as unknown as MockGainNode;
const ster = (host: AudioGraphHost) => host._graph._stereo as unknown as StereoSubNode;
const spat = (host: AudioGraphHost) => host._graph._spatial as unknown as SpatialSubNode;

async function makeEngine() {
    const ctx = new MockAudioContext();
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

function makeNode(engine: Awaited<ReturnType<typeof makeEngine>>): AudioNode {
    return new (globalThis as unknown as { GainNode: new (c: unknown) => AudioNode }).GainNode(engine._ctx);
}

describe("sound source", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    it("wraps a node and routes it through the graph to the main bus", async () => {
        const engine = await makeEngine();
        const node = makeNode(engine);
        const source = await createSoundSourceAsync(engine, node, { name: "input" });

        expect(source.name).toBe("input");
        expect(source._node).toBe(node);
        // Wrapped node connects to the graph head (the volume node by default).
        expect(asAudioNode(node).connections.has(asAudioNode(source._graph._volume) as never)).toBe(true);
        // Defaults to the engine's main bus.
        expect(source._outBus).toBe(engine._mainBus);
        // Registered for engine disposal.
        expect(engine._sounds.has(source)).toBe(true);
        disposeAudioEngine(engine);
    });

    it("does not auto-connect to the main bus when outBusAutoDefault is false", async () => {
        const engine = await makeEngine();
        const node = makeNode(engine);
        const source = await createSoundSourceAsync(engine, node, { outBusAutoDefault: false });
        expect(source._outBus).toBeNull();
        disposeAudioEngine(engine);
    });

    it("sets the source volume", async () => {
        const engine = await makeEngine();
        const node = makeNode(engine);
        const source = await createSoundSourceAsync(engine, node);
        setSoundSourceVolume(source, 0.5);
        expect(asAudioNode(source._graph._volume).gain.value).toBe(0.5);
        disposeAudioEngine(engine);
    });

    it("reconnects the wrapped node when stereo is enabled", async () => {
        const engine = await makeEngine();
        const node = makeNode(engine);
        const source = await createSoundSourceAsync(engine, node);

        enableStereo(source);

        const stereo = ster(source);
        expect(asAudioNode(node).connections.has(stereo._inputNode as never)).toBe(true);
        expect(asAudioNode(node).connections.has(asAudioNode(source._graph._volume) as never)).toBe(false);
        disposeAudioEngine(engine);
    });

    it("supports spatial + analyzer on a source", async () => {
        const engine = await makeEngine();
        const node = makeNode(engine);
        const source = await createSoundSourceAsync(engine, node);

        enableSpatial(source);
        enableAnalyzer(source);

        expect(asAudioNode(node).connections.has(spat(source)._inputNode as never)).toBe(true);
        // Analyzer taps the volume node.
        expect(asAudioNode(source._graph._volume).connections.has((source._graph._analyzer as unknown as { _node: unknown })._node as never)).toBe(true);
        disposeAudioEngine(engine);
    });
});

describe("microphone source", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
        uninstallMicrophoneMocks();
    });

    it("captures the mic and does not auto-route to the main bus", async () => {
        installMicrophoneMocks();
        const engine = await makeEngine();
        const source = await createMicrophoneSoundSourceAsync(engine, { name: "mic" });

        expect(source.name).toBe("mic");
        expect(source._outBus).toBeNull();
        const node = source._node as unknown as MockMediaStreamAudioSourceNode;
        expect(node.mediaStream).toBeInstanceOf(MockMediaStream);
        disposeAudioEngine(engine);
    });

    it("stops media-stream tracks on dispose", async () => {
        const stream = installMicrophoneMocks();
        const engine = await makeEngine();
        const source = await createMicrophoneSoundSourceAsync(engine);

        disposeSoundSource(source);

        expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
        expect(source._node).toBeNull();
        expect(engine._sounds.has(source)).toBe(false);
        disposeAudioEngine(engine);
    });

    it("rejects when microphone access is denied", async () => {
        installMicrophoneMocks({ deny: true });
        const engine = await makeEngine();
        await expect(createMicrophoneSoundSourceAsync(engine)).rejects.toThrow(/Unable to access microphone/);
        disposeAudioEngine(engine);
    });
});
