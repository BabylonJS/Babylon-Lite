import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext, MockAudioBuffer } from "./web-audio-mock.js";
import type { MockGainNode, MockStereoPannerNode, MockAnalyserNode, MockPannerNode } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createSoundAsync, playSound } from "../../../../packages/babylon-lite/src/audio/static-sound.js";
import { createAudioBusAsync } from "../../../../packages/babylon-lite/src/audio/audio-bus.js";
import { enableSpatial, type SpatialSubNode } from "../../../../packages/babylon-lite/src/audio/spatial.js";
import { enableStereo, setStereoPan, type StereoSubNode } from "../../../../packages/babylon-lite/src/audio/stereo.js";
import { enableAnalyzer, getByteFrequencyData, getFloatFrequencyData, type AnalyzerSubNode } from "../../../../packages/babylon-lite/src/audio/analyzer.js";
import type { AudioGraphHost } from "../../../../packages/babylon-lite/src/audio/host-types.js";

const asGain = (node: unknown) => node as unknown as MockGainNode;
const asStereo = (node: unknown) => node as unknown as MockStereoPannerNode;
const asAnalyser = (node: unknown) => node as unknown as MockAnalyserNode;
const asPanner = (node: unknown) => node as unknown as MockPannerNode;
// The graph stores narrow structural slots; the feature modules own the full nodes.
const ster = (host: AudioGraphHost) => host._graph._stereo as unknown as StereoSubNode;
const anal = (host: AudioGraphHost) => host._graph._analyzer as unknown as AnalyzerSubNode;
const spat = (host: AudioGraphHost) => host._graph._spatial as unknown as SpatialSubNode;

async function makeEngine() {
    const ctx = new MockAudioContext();
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

async function makeSound(engine: Awaited<ReturnType<typeof makeEngine>>) {
    return createSoundAsync(engine, new MockAudioBuffer() as unknown as AudioBuffer);
}

describe("stereo", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    it("builds a stereo sub-node and splices it before the volume node", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableStereo(sound);

        const stereo = ster(sound);
        expect(stereo).toBeTruthy();
        // Head of the graph is now the stereo panner input node.
        expect(sound._graph._in).toBe(stereo._inputNode);
        // Stereo → volume.
        expect(asStereo(stereo._inputNode).connections.has(asGain(sound._graph._volume) as never)).toBe(true);
        // Default pan is centered.
        expect(asStereo(stereo._inputNode).pan.value).toBe(0);
        disposeAudioEngine(engine);
    });

    it("applies the pan option on enable", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableStereo(sound, { pan: -0.5 });

        expect(asStereo(ster(sound)._inputNode).pan.value).toBe(-0.5);
        disposeAudioEngine(engine);
    });

    it("sets the pan, building the sub-node on first use", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        setStereoPan(sound, 0.75);

        expect(asStereo(ster(sound)._inputNode).pan.value).toBe(0.75);
        disposeAudioEngine(engine);
    });

    it("enables stereo on a bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "fx");
        enableStereo(bus, { pan: 1 });

        expect(asStereo(ster(bus)._inputNode).pan.value).toBe(1);
        expect(bus._graph._in).toBe(ster(bus)._inputNode);
        disposeAudioEngine(engine);
    });

    it("reconnects live instances when stereo is enabled after playback starts", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        playSound(sound);
        const instance = Array.from(sound._instances)[0]!;
        const volumeNode = sound._graph._volume;

        enableStereo(sound);

        const stereo = ster(sound);
        expect(asGain(instance._volumeNode).connections.has(stereo._inputNode as never)).toBe(true);
        expect(asGain(instance._volumeNode).connections.has(asGain(volumeNode) as never)).toBe(false);
        disposeAudioEngine(engine);
    });

    it("is idempotent — repeated enables reuse the same sub-node", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableStereo(sound);
        const first = ster(sound);
        enableStereo(sound, { pan: 0.2 });
        expect(ster(sound)).toBe(first);
        expect(asStereo(first._inputNode).pan.value).toBeCloseTo(0.2);
        disposeAudioEngine(engine);
    });
});

describe("spatial + stereo parallel topology", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    function expectParallel(host: AudioGraphHost) {
        const root = host._graph._root;
        const spatial = spat(host);
        const stereo = ster(host);
        expect(root).toBeTruthy();
        // Head is the split root gain.
        expect(host._graph._in).toBe(root);
        // Root fans out to both branches.
        expect(asGain(root).connections.has(spatial._inputNode as never)).toBe(true);
        expect(asGain(root).connections.has(stereo._inputNode as never)).toBe(true);
        // Both branches rejoin at the volume node.
        expect(asStereo(stereo._inputNode).connections.has(asGain(host._graph._volume) as never)).toBe(true);
        expect(asPanner(spatial._panner).connections.has(host._graph._volume as never)).toBe(true);
    }

    it("splits to both branches when spatial is enabled first", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableSpatial(sound);
        enableStereo(sound);
        expectParallel(sound);
        disposeAudioEngine(engine);
    });

    it("splits to both branches when stereo is enabled first", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableStereo(sound);
        enableSpatial(sound);
        expectParallel(sound);
        disposeAudioEngine(engine);
    });

    it("reconnects live instances onto the split root", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        playSound(sound);
        const instance = Array.from(sound._instances)[0]!;

        enableSpatial(sound);
        enableStereo(sound);

        const root = sound._graph._root!;
        expect(asGain(instance._volumeNode).connections.has(root as never)).toBe(true);
        // No longer connected to the spatial-only head.
        expect(asGain(instance._volumeNode).connections.has(spat(sound)._inputNode as never)).toBe(false);
        disposeAudioEngine(engine);
    });
});

describe("analyzer", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    it("taps the analyzer off the volume node without changing the head", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        const headBefore = sound._graph._in;
        enableAnalyzer(sound);

        const analyzer = anal(sound);
        expect(analyzer).toBeTruthy();
        // Volume → analyzer (a passive tap).
        expect(asGain(sound._graph._volume).connections.has(analyzer._node as never)).toBe(true);
        // The audible through-chain head is unchanged.
        expect(sound._graph._in).toBe(headBefore);
        disposeAudioEngine(engine);
    });

    it("applies default settings", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableAnalyzer(sound);

        const node = asAnalyser(anal(sound)._node);
        expect(node.fftSize).toBe(2048);
        expect(node.minDecibels).toBe(-100);
        expect(node.maxDecibels).toBe(-30);
        expect(node.smoothingTimeConstant).toBe(0.8);
        disposeAudioEngine(engine);
    });

    it("applies supplied options", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableAnalyzer(sound, { fftSize: 512, minDecibels: -90, maxDecibels: -10, smoothing: 0.5 });

        const node = asAnalyser(anal(sound)._node);
        expect(node.fftSize).toBe(512);
        expect(node.minDecibels).toBe(-90);
        expect(node.maxDecibels).toBe(-10);
        expect(node.smoothingTimeConstant).toBe(0.5);
        disposeAudioEngine(engine);
    });

    it("reconfigures an existing analyzer", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableAnalyzer(sound);
        const first = anal(sound);
        enableAnalyzer(sound, { fftSize: 256 });
        expect(anal(sound)).toBe(first);
        expect(asAnalyser(first._node).fftSize).toBe(256);
        disposeAudioEngine(engine);
    });

    it("lazily builds the analyzer when reading frequency data", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        expect(sound._graph._analyzer).toBeNull();

        const bytes = new Uint8Array(8);
        bytes.fill(7);
        getByteFrequencyData(sound, bytes);
        expect(sound._graph._analyzer).toBeTruthy();
        // Mock writes zeros.
        expect(Array.from(bytes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

        const floats = new Float32Array(4);
        getFloatFrequencyData(sound, floats);
        // Mock writes minDecibels.
        expect(Array.from(floats)).toEqual([-100, -100, -100, -100]);
        disposeAudioEngine(engine);
    });

    it("enables the analyzer on a bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "fx");
        enableAnalyzer(bus);
        expect(asGain(bus._graph._volume).connections.has(anal(bus)._node as never)).toBe(true);
        disposeAudioEngine(engine);
    });
});
