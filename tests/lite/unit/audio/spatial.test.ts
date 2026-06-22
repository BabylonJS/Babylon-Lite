import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext } from "./web-audio-mock.js";
import type { MockGainNode, MockPannerNode, MockAudioListener } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createSoundAsync, playSound } from "../../../../packages/babylon-lite/src/audio/static-sound.js";
import { createAudioBusAsync } from "../../../../packages/babylon-lite/src/audio/audio-bus.js";
import {
    enableSpatial,
    setSpatialPosition,
    attachSpatialTarget,
    detachSpatialTarget,
    setSpatialListenerPosition,
    updateSpatialAudio,
    setSpatialAutoUpdate,
    type SpatialTarget,
    type SpatialSubNode,
    type SpatialListener,
} from "../../../../packages/babylon-lite/src/audio/spatial.js";
import type { AudioGraphHost } from "../../../../packages/babylon-lite/src/audio/host-types.js";
import { createAudioSignal } from "../../../../packages/babylon-lite/src/audio/audio-signal.js";
import { MockAudioBuffer } from "./web-audio-mock.js";
import { mat4Translation } from "../../../../packages/babylon-lite/src/math/mat4-translation.js";

const asGain = (node: unknown) => node as unknown as MockGainNode;
const asPanner = (node: unknown) => node as unknown as MockPannerNode;
const asListener = (l: unknown) => l as unknown as MockAudioListener;
// The graph/engine store narrow structural slots; the spatial module owns the full nodes.
const spat = (host: AudioGraphHost) => host._graph._spatial as unknown as SpatialSubNode;
const lis = (engine: { _listener: unknown }) => engine._listener as unknown as SpatialListener;

async function makeEngine() {
    const ctx = new MockAudioContext();
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

async function makeSound(engine: Awaited<ReturnType<typeof makeEngine>>) {
    return createSoundAsync(engine, new MockAudioBuffer() as unknown as AudioBuffer);
}

describe("spatial", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    it("builds a panner sub-node and splices it before the volume node", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableSpatial(sound);

        const spatial = spat(sound);
        expect(spatial).toBeTruthy();
        // Head of the graph is now the panner input node.
        expect(sound._graph._in).toBe(spatial._inputNode);
        // Input → panner (panning enabled by default).
        expect(asGain(spatial._inputNode).connections.has(asPanner(spatial._panner) as never)).toBe(true);
        // Panner → volume.
        expect(asPanner(spatial._panner).connections.has(asGain(sound._graph._volume) as never)).toBe(true);
        disposeAudioEngine(engine);
    });

    it("sets the panner position", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        setSpatialPosition(sound, { x: 5, y: 6, z: 7 });

        const panner = asPanner(spat(sound)._panner);
        expect(panner.positionX.value).toBe(5);
        expect(panner.positionY.value).toBe(6);
        expect(panner.positionZ.value).toBe(7);
        disposeAudioEngine(engine);
    });

    it("maps cone/distance options onto the panner (radians → degrees)", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        enableSpatial(sound, {
            coneInnerAngle: Math.PI,
            coneOuterAngle: Math.PI * 2,
            coneOuterVolume: 0.25,
            distanceModel: "exponential",
            minDistance: 2,
            maxDistance: 50,
            rolloffFactor: 3,
            panningModel: "HRTF",
        });

        const panner = asPanner(spat(sound)._panner);
        expect(panner.coneInnerAngle).toBeCloseTo(180);
        expect(panner.coneOuterAngle).toBeCloseTo(360);
        expect(panner.coneOuterGain).toBe(0.25);
        expect(panner.distanceModel).toBe("exponential");
        expect(panner.refDistance).toBe(2);
        expect(panner.maxDistance).toBe(50);
        expect(panner.rolloffFactor).toBe(3);
        expect(panner.panningModel).toBe("HRTF");
        disposeAudioEngine(engine);
    });

    it("applies distance attenuation when panning is disabled", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        // Listener at origin (default); source far away on the linear model → ~0 gain.
        enableSpatial(sound, { panningEnabled: false, distanceModel: "linear", minDistance: 1, maxDistance: 100, position: { x: 100, y: 0, z: 0 } });

        const spatial = spat(sound);
        // Input routes through the attenuation node, not the panner.
        expect(asGain(spatial._inputNode).connections.has(spatial._attenuationNode as never)).toBe(true);
        expect(asGain(spatial._inputNode).connections.has(asPanner(spatial._panner) as never)).toBe(false);
        expect(asGain(spatial._attenuationNode).gain.value).toBeCloseTo(0, 5);
        disposeAudioEngine(engine);
    });

    it("creates and positions the listener", async () => {
        const engine = await makeEngine();
        setSpatialListenerPosition(engine, { x: 1, y: 2, z: 3 });

        expect(engine._listener).toBeTruthy();
        const listener = asListener(lis(engine)._listener);
        expect(listener.positionX.value).toBe(1);
        expect(listener.positionY.value).toBe(2);
        expect(listener.positionZ.value).toBe(3);
        disposeAudioEngine(engine);
    });

    it("attaches a sound to a world transform and follows it on update", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        const target: SpatialTarget = { worldMatrix: mat4Translation(4, 5, 6) };

        attachSpatialTarget(sound, target, "position");
        expect(engine._spatialUpdaters.size).toBe(1);
        updateSpatialAudio(engine);

        const panner = asPanner(spat(sound)._panner);
        expect(panner.positionX.value).toBe(4);
        expect(panner.positionY.value).toBe(5);
        expect(panner.positionZ.value).toBe(6);
        disposeAudioEngine(engine);
    });

    it("attaches the listener to a world transform", async () => {
        const engine = await makeEngine();
        const target: SpatialTarget = { worldMatrix: mat4Translation(7, 8, 9) };

        attachSpatialTarget(engine, target, "position");
        updateSpatialAudio(engine);

        const listener = asListener(lis(engine)._listener);
        expect(listener.positionX.value).toBe(7);
        expect(listener.positionY.value).toBe(8);
        expect(listener.positionZ.value).toBe(9);
        disposeAudioEngine(engine);
    });

    it("detaches from a world transform", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        attachSpatialTarget(sound, { worldMatrix: mat4Translation(1, 1, 1) });
        expect(engine._spatialUpdaters.size).toBe(1);
        detachSpatialTarget(sound);
        expect(engine._spatialUpdaters.size).toBe(0);
        disposeAudioEngine(engine);
    });

    it("auto-detaches when the target is disposed", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        const onDispose = createAudioSignal<unknown>();
        attachSpatialTarget(sound, { worldMatrix: mat4Translation(2, 2, 2), onDispose });
        expect(engine._spatialUpdaters.size).toBe(1);
        onDispose._notify(undefined);
        expect(engine._spatialUpdaters.size).toBe(0);
        disposeAudioEngine(engine);
    });

    it("reconnects live instances when spatial is enabled after playback starts", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        playSound(sound);
        const instance = Array.from(sound._instances)[0]!;
        const volumeNode = sound._graph._volume;

        enableSpatial(sound);

        const spatial = spat(sound);
        expect(asGain(instance._volumeNode).connections.has(spatial._inputNode as never)).toBe(true);
        expect(asGain(instance._volumeNode).connections.has(asGain(volumeNode) as never)).toBe(false);
        disposeAudioEngine(engine);
    });

    it("enables spatial on a bus", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "fx");
        enableSpatial(bus, { position: { x: 1, y: 0, z: 0 } });
        expect(bus._graph._spatial).toBeTruthy();
        expect(bus._graph._in).toBe(spat(bus)._inputNode);
        disposeAudioEngine(engine);
    });

    it("disposes the listener and clears updaters on engine dispose", async () => {
        const engine = await makeEngine();
        const sound = await makeSound(engine);
        setSpatialListenerPosition(engine, { x: 1, y: 0, z: 0 });
        attachSpatialTarget(sound, { worldMatrix: mat4Translation(1, 1, 1) });
        expect(engine._spatialUpdaters.size).toBe(1);

        disposeAudioEngine(engine);
        expect(engine._listener).toBeNull();
        expect(engine._spatialUpdaters.size).toBe(0);
    });

    it("setSpatialAutoUpdate is a no-op without requestAnimationFrame", async () => {
        const engine = await makeEngine();
        expect(() => setSpatialAutoUpdate(engine, true, 16)).not.toThrow();
        expect(engine._spatialAutoStop).toBeNull();
        disposeAudioEngine(engine);
    });
});
