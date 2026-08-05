import { describe, expect, it } from "vitest";

import {
    SoundState,
    AudioParameterRampShape,
    SpatialAudioAttachmentType,
    AbstractAudioNode,
    AbstractNamedAudioNode,
    AbstractAudioOutNode,
    AbstractAudioBus,
    AbstractSoundSource,
    AbstractSound,
    AudioBus,
    MainAudioBus,
    SoundSource,
    StaticSound,
    StreamingSound,
    StaticSoundBuffer,
    AudioEngineV2,
    AbstractSpatialAudio,
    AbstractStereoAudio,
    AbstractAudioAnalyzer,
    AbstractSpatialAudioListener,
    CreateSoundAsync,
    CreateAudioBusAsync,
    LastCreatedAudioEngine,
    LiteCompatError,
} from "../src/index";
import { toLiteRamp } from "../src/audio/audio-enums";

/**
 * GPU-free coverage for the AudioV2 compat wrappers. Node has no Web Audio
 * device, so the real Lite audio functions (which build `AudioContext` graph
 * nodes) cannot run here. These tests exercise the pure-logic surface: enum
 * values, ramp-option mapping, property get/set proxying against a minimal fake
 * Lite handle, the class hierarchy / `instanceof` chain, observable wiring, and
 * the throwing paths. The full graph behaviour is covered by the Lite audio
 * suite, which renders an `OfflineAudioContext` to PCM.
 */

function makeSignal<T>(): { add(cb: (v: T) => void): () => void; _fire(v: T): void } {
    const cbs: Array<(v: T) => void> = [];
    return {
        add(cb) {
            cbs.push(cb);
            return () => cbs.splice(cbs.indexOf(cb), 1);
        },
        _fire(v) {
            for (const cb of cbs.slice()) {
                cb(v);
            }
        },
    };
}

/** A minimal fake Lite audio engine that `AudioEngineV2` + `disposeAudioEngine` tolerate. */
function makeFakeLiteEngine(): any {
    return {
        currentTime: 1.5,
        state: "running",
        _rampDuration: 0.01,
        _volume: 1,
        _ctx: { state: "closed" },
        _isOffline: true,
        _mainBus: { name: "default", _volume: { disconnect() {} } },
        _mainOut: { _gain: { disconnect() {} } },
        _sounds: new Set(),
        _buses: new Set(),
        _spatialUpdaters: new Set(),
        _spatialAutoStop: null,
        _listener: null,
        _disposers: [],
        _onStateChanged: { _clear() {} },
        _onUserGesture: { _clear() {} },
    };
}

/** A minimal fake Lite StaticSound carrying the stored-options bag the wrapper proxies. */
function makeFakeLiteStaticSound(): any {
    return {
        name: "shoot",
        state: SoundState.Stopped,
        instanceCount: 0,
        buffer: { duration: 2, sampleRate: 48000, channelCount: 2, length: 96000 },
        onEnded: makeSignal(),
        _instances: new Set(),
        _options: {
            autoplay: false,
            duration: 0,
            loop: false,
            loopEnd: 0,
            loopStart: 0,
            maxInstances: Infinity,
            pitch: 0,
            playbackRate: 1,
            startOffset: 0,
        },
    };
}

describe("AudioV2 enums", () => {
    it("SoundState matches Babylon.js values", () => {
        expect(SoundState.Stopping).toBe(0);
        expect(SoundState.Stopped).toBe(1);
        expect(SoundState.Starting).toBe(2);
        expect(SoundState.Started).toBe(3);
        expect(SoundState.FailedToStart).toBe(4);
        expect(SoundState.Paused).toBe(5);
    });

    it("AudioParameterRampShape matches Babylon.js values", () => {
        expect(AudioParameterRampShape.Linear).toBe("linear");
        expect(AudioParameterRampShape.Exponential).toBe("exponential");
        expect(AudioParameterRampShape.Logarithmic).toBe("logarithmic");
        expect(AudioParameterRampShape.None).toBe("none");
    });

    it("SpatialAudioAttachmentType matches Babylon.js values", () => {
        expect(SpatialAudioAttachmentType.Position).toBe(1);
        expect(SpatialAudioAttachmentType.Rotation).toBe(2);
        expect(SpatialAudioAttachmentType.PositionAndRotation).toBe(3);
    });

    it("maps ramp options to the Lite shape", () => {
        expect(toLiteRamp(undefined)).toBeUndefined();
        expect(toLiteRamp({ duration: 0.5, shape: AudioParameterRampShape.Exponential })).toEqual({ duration: 0.5, shape: "exponential" });
    });
});

describe("AudioEngineV2", () => {
    it("reads state/currentTime/volume from the Lite engine", () => {
        const lite = makeFakeLiteEngine();
        const engine = new AudioEngineV2(lite);
        expect(engine.state).toBe("running");
        expect(engine.currentTime).toBe(1.5);
        lite._volume = 0.42;
        expect(engine.volume).toBe(0.42);
        engine.dispose();
    });

    it("proxies parameterRampDuration to the Lite engine", () => {
        const lite = makeFakeLiteEngine();
        const engine = new AudioEngineV2(lite);
        expect(engine.parameterRampDuration).toBe(0.01);
        engine.parameterRampDuration = 0.25;
        expect(lite._rampDuration).toBe(0.25);
        engine.dispose();
    });

    it("exposes the default main bus, listener and main out", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        expect(engine.defaultMainBus).toBeInstanceOf(MainAudioBus);
        expect(engine.defaultMainBus).toBe(engine.defaultMainBus); // cached
        expect(engine.listener).toBeInstanceOf(AbstractSpatialAudioListener);
        expect(engine.mainOut.getClassName()).toBe("_MainAudioOut");
        engine.dispose();
    });

    it("validates audio formats via mime types", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        expect(engine.isFormatValid("mp3")).toBe(true);
        expect(engine.isFormatValid("xyz")).toBe(false);
        engine.dispose();
    });

    it("tracks live engines in the static Instances array and untracks on dispose", () => {
        const before = AudioEngineV2.Instances.length;
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        expect(AudioEngineV2.Instances.length).toBe(before + 1);
        engine.dispose();
        expect(AudioEngineV2.Instances.length).toBe(before);
    });

    it("tracks created sounds in the sounds list", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const buffer = new StaticSoundBuffer(engine, makeFakeLiteStaticSound().buffer);
        const sound = new StaticSound(engine, makeFakeLiteStaticSound(), buffer, engine.defaultMainBus, false);
        expect(engine.sounds).toContain(sound);
        engine.dispose();
    });
});

describe("StaticSound", () => {
    function build(): { engine: AudioEngineV2; lite: any; sound: StaticSound } {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const lite = makeFakeLiteStaticSound();
        const buffer = new StaticSoundBuffer(engine, lite.buffer, "shoot");
        const sound = new StaticSound(engine, lite, buffer, engine.defaultMainBus, false);
        return { engine, lite, sound };
    }

    it("mirrors the Babylon.js class hierarchy", () => {
        const { sound } = build();
        expect(sound).toBeInstanceOf(AbstractSound);
        expect(sound).toBeInstanceOf(AbstractSoundSource);
        expect(sound).toBeInstanceOf(AbstractAudioOutNode);
        expect(sound).toBeInstanceOf(AbstractNamedAudioNode);
        expect(sound).toBeInstanceOf(AbstractAudioNode);
        expect(sound.getClassName()).toBe("StaticSound");
    });

    it("reads state, name and buffer metadata from the Lite handle", () => {
        const { sound, lite } = build();
        expect(sound.name).toBe("shoot");
        expect(sound.state).toBe(SoundState.Stopped);
        lite.state = SoundState.Started;
        expect(sound.state).toBe(SoundState.Started);
        expect(sound.activeInstancesCount).toBe(0);
        expect(sound.buffer.duration).toBe(2);
        expect(sound.buffer.sampleRate).toBe(48000);
        expect(sound.buffer.channelCount).toBe(2);
    });

    it("proxies stored playback options to the Lite options bag", () => {
        const { sound, lite } = build();
        sound.loop = true;
        sound.startOffset = 0.5;
        sound.maxInstances = 3;
        sound.duration = 1.2;
        sound.loopStart = 0.1;
        sound.loopEnd = 1.9;
        expect(lite._options).toMatchObject({ loop: true, startOffset: 0.5, maxInstances: 3, duration: 1.2, loopStart: 0.1, loopEnd: 1.9 });
        // getters reflect the same bag
        expect(sound.loop).toBe(true);
        expect(sound.startOffset).toBe(0.5);
        expect(sound.currentTime).toBe(0.5); // currentTime aliases startOffset
    });

    it("propagates pitch and playbackRate to active instances", () => {
        const { sound, lite } = build();
        const instance = { _sourceNode: { detune: { value: 0 }, playbackRate: { value: 1 } } };
        lite._instances.add(instance);
        sound.pitch = 600;
        sound.playbackRate = 1.5;
        expect(lite._options.pitch).toBe(600);
        expect(lite._options.playbackRate).toBe(1.5);
        expect(instance._sourceNode.detune.value).toBe(600);
        expect(instance._sourceNode.playbackRate.value).toBe(1.5);
    });

    it("fires onEndedObservable when the Lite sound ends", () => {
        const { sound, lite } = build();
        let fired: AbstractSound | null = null;
        sound.onEndedObservable.add((s) => (fired = s));
        lite.onEnded._fire(lite);
        expect(fired).toBe(sound);
    });
});

describe("StreamingSound", () => {
    it("mirrors the hierarchy and proxies preload counts", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const lite: any = {
            name: "music",
            state: SoundState.Stopped,
            instanceCount: 0,
            preloadCompletedCount: 2,
            onEnded: makeSignal(),
            _options: { autoplay: false, loop: false, maxInstances: Infinity, preloadCount: 3, startOffset: 0 },
        };
        const sound = new StreamingSound(engine, lite, engine.defaultMainBus, { preloadCount: 3 });
        expect(sound).toBeInstanceOf(AbstractSound);
        expect(sound.getClassName()).toBe("StreamingSound");
        expect(sound.preloadCount).toBe(3);
        expect(sound.preloadCompletedCount).toBe(2);
        sound.loop = true;
        expect(lite._options.loop).toBe(true);
        engine.dispose();
    });
});

describe("AudioBus / MainAudioBus", () => {
    it("AudioBus mirrors the bus hierarchy and exposes spatial/stereo", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const liteBus: any = { name: "music" };
        const bus = new AudioBus(engine, liteBus, engine.defaultMainBus);
        expect(bus).toBeInstanceOf(AbstractAudioBus);
        expect(bus).toBeInstanceOf(AbstractAudioOutNode);
        expect(bus.getClassName()).toBe("AudioBus");
        expect(bus.name).toBe("music");
        expect(bus.spatial).toBeInstanceOf(AbstractSpatialAudio);
        expect(bus.stereo).toBeInstanceOf(AbstractStereoAudio);
        expect(bus.outBus).toBe(engine.defaultMainBus);
        engine.dispose();
    });

    it("MainAudioBus has no analyzer (unsupported on a main bus)", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const bus = engine.defaultMainBus!;
        expect(bus).toBeInstanceOf(MainAudioBus);
        expect(() => bus.analyzer).toThrow(LiteCompatError);
        engine.dispose();
    });
});

describe("SoundSource", () => {
    it("mirrors the source hierarchy", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const lite: any = { name: "mic", _instances: new Set() };
        const source = new SoundSource(engine, lite, null);
        expect(source).toBeInstanceOf(AbstractSoundSource);
        expect(source).toBeInstanceOf(AbstractAudioOutNode);
        expect(source.getClassName()).toBe("SoundSource");
        engine.dispose();
    });
});

describe("review-feedback fixes", () => {
    it("StaticSound uses the caller-provided name over the Lite handle and the creation volume", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const lite = makeFakeLiteStaticSound(); // lite.name === "shoot"
        const buffer = new StaticSoundBuffer(engine, lite.buffer, "explosion");
        const sound = new StaticSound(engine, lite, buffer, engine.defaultMainBus, false, "explosion", 0.3);
        expect(sound.name).toBe("explosion");
        expect(sound.volume).toBe(0.3);
        engine.dispose();
    });

    it("StreamingSound initializes volume from creation options and uses the caller name", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const lite: any = { name: "fallback", state: SoundState.Stopped, instanceCount: 0, preloadCompletedCount: 0, onEnded: makeSignal(), _options: {} };
        const sound = new StreamingSound(engine, lite, engine.defaultMainBus, { volume: 0.7 }, "track");
        expect(sound.name).toBe("track");
        expect(sound.volume).toBe(0.7);
        engine.dispose();
    });

    it("AudioBus and SoundSource initialize volume from the creation volume", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const bus = new AudioBus(engine, { name: "music" } as any, engine.defaultMainBus, 0.25);
        const source = new SoundSource(engine, { name: "mic", _instances: new Set() } as any, null, 0.6);
        expect(bus.volume).toBe(0.25);
        expect(source.volume).toBe(0.6);
        engine.dispose();
    });

    it("AudioBus.outBus reassignment reroutes the Lite output graph", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const connected: any[] = [];
        const disconnected: any[] = [];
        const tail = { connect: (n: any) => connected.push(n), disconnect: (n: any) => disconnected.push(n) };
        const oldIn = { id: "old-in" };
        const newIn = { id: "new-in" };
        const oldLiteBus: any = { name: "old", _graph: { _in: oldIn } };
        const newLiteBus: any = { name: "new", _graph: { _in: newIn } };
        const oldCompat = new AudioBus(engine, oldLiteBus, null);
        const newCompat = new AudioBus(engine, newLiteBus, null);
        const liteBus: any = { name: "src", _graph: { _in: {}, _out: tail }, _outBus: oldLiteBus };
        const bus = new AudioBus(engine, liteBus, oldCompat);

        bus.outBus = newCompat;

        expect(disconnected).toContain(oldIn);
        expect(connected).toContain(newIn);
        expect(bus.outBus).toBe(newCompat);
        expect(liteBus._outBus).toBe(newLiteBus);

        // Reassigning to the same bus is a no-op (no extra connect calls).
        const connectsBefore = connected.length;
        bus.outBus = newCompat;
        expect(connected.length).toBe(connectsBefore);
        engine.dispose();
    });

    it("SoundSource.outBus reassignment reroutes the Lite output graph", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const connected: any[] = [];
        const tail = { connect: (n: any) => connected.push(n), disconnect() {} };
        const newIn = { id: "new-in" };
        const newLiteBus: any = { name: "new", _graph: { _in: newIn } };
        const newCompat = new AudioBus(engine, newLiteBus, null);
        const liteSource: any = { name: "mic", _instances: new Set(), _graph: { _in: {}, _out: tail }, _outBus: null };
        const source = new SoundSource(engine, liteSource, null);

        source.outBus = newCompat;

        expect(connected).toContain(newIn);
        expect(source.outBus).toBe(newCompat);
        expect(liteSource._outBus).toBe(newLiteBus);
        engine.dispose();
    });
});

describe("sub-properties (defaults)", () => {
    it("AbstractSpatialAudio exposes Babylon.js defaults before enabling", () => {
        const spatial = new AbstractSpatialAudio({} as any);
        expect(spatial.position.x).toBe(0);
        expect(spatial.coneInnerAngle).toBeCloseTo(2 * Math.PI);
        expect(spatial.maxDistance).toBe(10000);
        expect(spatial.minDistance).toBe(1);
        expect(spatial.panningModel).toBe("equalpower");
        expect(spatial.distanceModel).toBe("linear");
        expect(spatial.isAttached).toBe(false);
        expect(spatial.attachedNode).toBeNull();
    });

    it("AbstractStereoAudio defaults to centre pan", () => {
        const stereo = new AbstractStereoAudio({} as any);
        expect(stereo.pan).toBe(0);
    });

    it("AbstractAudioAnalyzer exposes defaults and empty data while disabled", () => {
        const analyzer = new AbstractAudioAnalyzer({} as any);
        expect(analyzer.fftSize).toBe(2048);
        expect(analyzer.frequencyBinCount).toBe(1024);
        expect(analyzer.isEnabled).toBe(false);
        expect(analyzer.getByteFrequencyData()).toHaveLength(0);
        expect(analyzer.getFloatFrequencyData()).toHaveLength(0);
        expect(analyzer.getByteTimeDomainData()).toHaveLength(0);
        expect(analyzer.getFloatTimeDomainData()).toHaveLength(0);
    });
});

describe("named-node observables", () => {
    it("fires onNameChangedObservable when a node is renamed", () => {
        const engine = new AudioEngineV2(makeFakeLiteEngine());
        const bus = new AudioBus(engine, { name: "a" } as any, null);
        let change: { newName: string; oldName: string } | null = null;
        bus.onNameChangedObservable.add((c) => (change = c));
        bus.name = "b";
        expect(change).toMatchObject({ newName: "b", oldName: "a" });
        engine.dispose();
    });

    it("fires engine node-added/removed observables", () => {
        const liteEngine = makeFakeLiteEngine();
        const engine = new AudioEngineV2(liteEngine);
        let added: unknown = null;
        let removed: unknown = null;
        engine.onNodeAddedObservable.add((n) => (added = n));
        engine.onNodeRemovedObservable.add((n) => (removed = n));
        const liteBus: any = {
            name: "a",
            _engine: liteEngine,
            _graph: { _spatial: null, _stereo: null, _analyzer: null, _root: { disconnect() {} }, _volume: { disconnect() {} } },
        };
        const bus = new AudioBus(engine, liteBus, null);
        expect(added).toBe(bus);
        expect(engine.nodes.has(bus)).toBe(true);
        bus.dispose();
        expect(removed).toBe(bus);
        expect(engine.nodes.has(bus)).toBe(false);
        engine.dispose();
    });
});

describe("factory functions without an engine", () => {
    it("throw a discoverable error when no engine exists", () => {
        // No engine has been created in this test, so LastCreatedAudioEngine is null.
        expect(LastCreatedAudioEngine()).toBeNull();
        expect(() => CreateSoundAsync("s", "x.mp3")).toThrow(LiteCompatError);
        expect(() => CreateAudioBusAsync("b")).toThrow(LiteCompatError);
    });
});
