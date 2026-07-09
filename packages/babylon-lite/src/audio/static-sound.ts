/**
 * Static sounds (fully-decoded, buffer-backed) and their play instances.
 *
 * Faithful port of AudioV2 `_WebAudioStaticSound` / `_WebAudioStaticSoundInstance`
 * (and the relevant `AbstractSound` instance management), collapsed to pure
 * state + standalone functions.
 *
 * Graph per playing instance (Phase 1):
 *
 * `AudioBufferSourceNode` -\> `instance._volumeNode` -\> `sound._graph._in`
 *   -\> `sound._graph._out` -\> `outBus._in` -\> `mainBus` -\> `mainOut` -\> destination
 *
 * Each `playSound` call spawns a fresh `AudioBufferSourceNode` (Web Audio source
 * nodes are single-use), exactly as Babylon.js does.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type PrimaryAudioBus, getBusInputNode } from "./audio-bus.js";
import { type RampOptions, type RampParam, createRampParam, setRampTarget } from "./audio-param.js";
import { type AudioSignal, type AudioSignalImpl, createAudioSignal } from "./audio-signal.js";
import { type SoundBuffer, type SoundBufferOptions, type SoundSource, createSoundBufferAsync } from "./sound-buffer.js";
import { type SoundSubGraph, connectSoundSubGraph, createSoundSubGraph, disposeSoundSubGraph, setSoundSubGraphVolume } from "./sound-sub-graph.js";

/** Playback state of a sound or sound instance. Values match Babylon.js exactly. */
export const SoundState = {
    Stopping: 0,
    Stopped: 1,
    Starting: 2,
    Started: 3,
    FailedToStart: 4,
    Paused: 5,
} as const;
export type SoundState = (typeof SoundState)[keyof typeof SoundState];

/** Options for {@link createSoundAsync}. */
export interface StaticSoundOptions extends SoundBufferOptions {
    /** Play immediately once ready. Defaults to `false`. */
    autoplay?: boolean;
    /** Play duration in seconds (`0` = full buffer). Defaults to `0`. */
    duration?: number;
    /** Loop playback. Defaults to `false`. */
    loop?: boolean;
    /** Loop end point in seconds. Defaults to `0`. */
    loopEnd?: number;
    /** Loop start point in seconds. Defaults to `0`. */
    loopStart?: number;
    /** Maximum simultaneous instances. Defaults to `Infinity`. */
    maxInstances?: number;
    /** Output bus. Defaults to the engine's default main bus. */
    outBus?: PrimaryAudioBus;
    /** Detune in cents. Defaults to `0`. */
    pitch?: number;
    /** Playback rate multiplier. Defaults to `1`. */
    playbackRate?: number;
    /** Start offset in seconds. Defaults to `0`. */
    startOffset?: number;
    /** Initial volume. Defaults to `1`. */
    volume?: number;
}

/** Per-play overrides for {@link playSound}. */
export interface StaticSoundPlayOptions {
    /** Play duration in seconds (`0` = full buffer). */
    duration?: number;
    /** Loop playback. */
    loop?: boolean;
    /** Loop end point in seconds. */
    loopEnd?: number;
    /** Loop start point in seconds. */
    loopStart?: number;
    /** Detune of this instance, in cents. Defaults to the sound's `pitch`. */
    pitch?: number;
    /** Playback rate multiplier of this instance. Defaults to the sound's `playbackRate`. */
    playbackRate?: number;
    /** Start offset in seconds. */
    startOffset?: number;
    /** Per-instance volume. */
    volume?: number;
    /** Delay before playback starts, in seconds. */
    waitTime?: number;
}

/** Options for {@link stopSound}. */
export interface StaticSoundStopOptions {
    /** Delay before stopping, in seconds. */
    waitTime?: number;
}

interface StoredOptions {
    autoplay: boolean;
    duration: number;
    loop: boolean;
    loopEnd: number;
    loopStart: number;
    maxInstances: number;
    pitch: number;
    playbackRate: number;
    startOffset: number;
}

/** A buffer-backed sound. Pure state — drive it with the sound functions. */
export interface StaticSound {
    /** Optional name. */
    readonly name?: string;
    /** The decoded buffer this sound plays. */
    readonly buffer: SoundBuffer;
    /** Current playback state. */
    readonly state: SoundState;
    /** Number of live instances. */
    readonly instanceCount: number;
    /** Fires when the sound finishes (all instances ended). */
    readonly onEnded: AudioSignal<StaticSound>;

    /** @internal */ _engine: AudioEngine;
    /** @internal */ _buffer: SoundBuffer;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _outBus: PrimaryAudioBus;
    /** @internal */ _options: StoredOptions;
    /** @internal */ _instances: Set<SoundInstance>;
    /** @internal */ _newest: SoundInstance | null;
    /** @internal */ _state: SoundState;
    /** @internal */ _onEnded: AudioSignalImpl<StaticSound>;
    /** @internal */ _dispose(): void;
}

/** A single in-flight playback of a {@link StaticSound}. @internal */
export interface SoundInstance {
    /** @internal */ _sound: StaticSound;
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _options: { duration: number; loop: boolean; loopEnd: number; loopStart: number; pitch: number; playbackRate: number; startOffset: number };
    /** @internal */ _volumeNode: GainNode;
    /** @internal */ _sourceNode: AudioBufferSourceNode | null;
    /** @internal */ _state: SoundState;
    /** @internal */ _enginePlayTime: number;
    /** @internal */ _enginePauseTime: number;
    /** @internal */ _isConnected: boolean;
    /** @internal */ _pitch: RampParam | null;
    /** @internal */ _playbackRate: RampParam | null;
    /** @internal */ _engineStateUnsub: (() => void) | null;
    /** @internal */ _onEnded: AudioSignalImpl<SoundInstance>;
    /** @internal */ _onStateChanged: AudioSignalImpl<SoundInstance>;
    /** @internal */ _endedHandler: () => void;
    /** @internal */ _engineStateHandler: () => void;
}

/**
 * Creates a buffer-backed sound, routed to the given output bus (or the
 * engine's default main bus).
 * @param engine - The audio engine.
 * @param source - An `AudioBuffer`, `ArrayBuffer`, URL, URL list, or `SoundBuffer`.
 * @param options - Sound options.
 * @returns A promise that resolves with the ready sound.
 */
export async function createSoundAsync(engine: AudioEngine, source: SoundSource, options: StaticSoundOptions = {}): Promise<StaticSound> {
    const buffer = await createSoundBufferAsync(engine, source, options);
    const graph = createSoundSubGraph(engine._ctx, engine, options.volume ?? 1);
    const outBus = options.outBus ?? engine._mainBus;
    connectSoundSubGraph(graph, getBusInputNode(outBus));

    const onEnded = createAudioSignal<StaticSound>();

    const sound: StaticSound = {
        get state() {
            return sound._state;
        },
        get instanceCount() {
            return sound._instances.size;
        },
        get buffer() {
            return sound._buffer;
        },
        get onEnded(): AudioSignal<StaticSound> {
            return onEnded;
        },
        _engine: engine,
        _buffer: buffer,
        _graph: graph,
        _outBus: outBus,
        _options: {
            autoplay: options.autoplay ?? false,
            duration: options.duration ?? 0,
            loop: options.loop ?? false,
            loopEnd: options.loopEnd ?? 0,
            loopStart: options.loopStart ?? 0,
            maxInstances: options.maxInstances ?? Infinity,
            pitch: options.pitch ?? 0,
            playbackRate: options.playbackRate ?? 1,
            startOffset: options.startOffset ?? 0,
        },
        _instances: new Set<SoundInstance>(),
        _newest: null,
        _state: SoundState.Stopped,
        _onEnded: onEnded,
        _dispose: () => disposeSound(sound),
    };

    engine._sounds.add(sound);

    if (sound._options.autoplay) {
        playSound(sound);
    }

    return sound;
}

/** Sets the sound's output volume, optionally ramping. */
export function setSoundVolume(sound: StaticSound, value: number, options?: RampOptions): void {
    setSoundSubGraphVolume(sound._graph, value, options);
}

/**
 * Plays the sound. Spawns a new instance per call (subject to `maxInstances`).
 * A paused sound is resumed instead.
 * @param sound - The sound to play.
 * @param options - Per-play overrides.
 */
export function playSound(sound: StaticSound, options: StaticSoundPlayOptions = {}): void {
    if (sound._state === SoundState.Paused) {
        resumeSound(sound, options);
        return;
    }

    const opts: Required<StaticSoundPlayOptions> = {
        duration: options.duration ?? sound._options.duration,
        loop: options.loop ?? sound._options.loop,
        loopStart: options.loopStart ?? sound._options.loopStart,
        loopEnd: options.loopEnd ?? sound._options.loopEnd,
        pitch: options.pitch ?? sound._options.pitch,
        playbackRate: options.playbackRate ?? sound._options.playbackRate,
        startOffset: options.startOffset ?? sound._options.startOffset,
        volume: options.volume ?? 1,
        waitTime: options.waitTime ?? 0,
    };

    const instance = _createInstance(sound);
    instance._onEnded.addOnce(instance._endedHandler);
    sound._instances.add(instance);
    sound._newest = instance;

    _instancePlay(instance, opts);

    sound._state = instance._state;
    _stopExcessInstances(sound);
}

/** Pauses all of the sound's instances. */
export function pauseSound(sound: StaticSound): void {
    for (const instance of sound._instances) {
        _instancePause(instance);
    }
    sound._state = SoundState.Paused;
}

/** Resumes a paused sound. */
export function resumeSound(sound: StaticSound, options: StaticSoundPlayOptions = {}): void {
    if (sound._state !== SoundState.Paused) {
        return;
    }
    for (const instance of sound._instances) {
        _instanceResume(instance, options);
    }
    sound._state = SoundState.Started;
}

/** Stops the sound (and all its instances). */
export function stopSound(sound: StaticSound, options: StaticSoundStopOptions = {}): void {
    sound._state = options.waitTime && options.waitTime > 0 ? SoundState.Stopping : SoundState.Stopped;
    for (const instance of Array.from(sound._instances)) {
        _instanceStop(instance, options);
    }
}

/** Disposes the sound, stopping playback and releasing its graph. */
export function disposeSound(sound: StaticSound): void {
    stopSound(sound);
    for (const instance of Array.from(sound._instances)) {
        _instanceDispose(instance);
    }
    sound._instances.clear();
    disposeSoundSubGraph(sound._graph);
    sound._onEnded._clear();
    sound._engine._sounds.delete(sound);
}

function _stopExcessInstances(sound: StaticSound): void {
    if (sound._options.maxInstances < Infinity) {
        const started = Array.from(sound._instances).filter((i) => i._state === SoundState.Started);
        const toStop = started.length - sound._options.maxInstances;
        for (let i = 0; i < toStop; i++) {
            _instanceStop(started[i]!);
        }
    }
}

function _onInstanceEnded(sound: StaticSound, instance: SoundInstance): void {
    if (sound._newest === instance) {
        sound._newest = null;
    }
    sound._instances.delete(instance);
    if (sound._instances.size === 0) {
        sound._state = SoundState.Stopped;
        sound._onEnded._notify(sound);
    }
    _instanceDispose(instance);
}

// --- Instance ---------------------------------------------------------------

function _createInstance(sound: StaticSound): SoundInstance {
    const engine = sound._engine;
    const instance: SoundInstance = {
        _sound: sound,
        _engine: engine,
        _options: {
            duration: sound._options.duration,
            loop: sound._options.loop,
            loopEnd: sound._options.loopEnd,
            loopStart: sound._options.loopStart,
            pitch: sound._options.pitch,
            playbackRate: sound._options.playbackRate,
            startOffset: sound._options.startOffset,
        },
        _volumeNode: new GainNode(engine._ctx),
        _sourceNode: null,
        _state: SoundState.Stopped,
        _enginePlayTime: 0,
        _enginePauseTime: 0,
        _isConnected: false,
        _pitch: null,
        _playbackRate: null,
        _engineStateUnsub: null,
        _onEnded: createAudioSignal<SoundInstance>(),
        _onStateChanged: createAudioSignal<SoundInstance>(),
        _endedHandler: () => _onInstanceEnded(sound, instance),
        _engineStateHandler: () => _onEngineStateChanged(instance),
    };
    return instance;
}

function _setInstanceState(instance: SoundInstance, state: SoundState): void {
    instance._state = state;
    instance._onStateChanged._notify(instance);
}

function _instancePlay(instance: SoundInstance, options: Required<StaticSoundPlayOptions>): void {
    if (instance._state === SoundState.Started) {
        return;
    }

    instance._options.duration = options.duration;
    instance._options.loop = options.loop;
    instance._options.loopStart = options.loopStart;
    instance._options.loopEnd = options.loopEnd;
    instance._options.pitch = options.pitch;
    instance._options.playbackRate = options.playbackRate;
    instance._options.startOffset = options.startOffset;

    let startOffset = instance._options.startOffset;
    if (instance._state === SoundState.Paused) {
        startOffset += instance._enginePauseTime;
        startOffset %= instance._sound._buffer.duration;
    }

    instance._enginePlayTime = instance._engine.currentTime + options.waitTime;

    if (options.volume !== undefined) {
        instance._volumeNode.gain.value = options.volume;
    }

    _initSourceNode(instance);

    if (instance._engine.state === "running") {
        _setInstanceState(instance, SoundState.Started);
        instance._sourceNode?.start(instance._enginePlayTime, startOffset, instance._options.duration > 0 ? instance._options.duration : undefined);
    } else if (instance._options.loop) {
        _setInstanceState(instance, SoundState.Starting);
        instance._engineStateUnsub = instance._engine.onStateChanged.add(instance._engineStateHandler);
    }
}

function _instancePause(instance: SoundInstance): void {
    if (instance._state !== SoundState.Started && instance._state !== SoundState.Starting) {
        return;
    }

    const wasStarted = instance._state === SoundState.Started;
    _setInstanceState(instance, SoundState.Paused);
    instance._enginePauseTime += instance._engine.currentTime - instance._enginePlayTime;

    if (wasStarted) {
        instance._sourceNode?.stop();
    } else {
        instance._engineStateUnsub?.();
        instance._engineStateUnsub = null;
    }

    _deinitSourceNode(instance);
}

function _instanceResume(instance: SoundInstance, options: StaticSoundPlayOptions): void {
    if (instance._state === SoundState.Paused) {
        const opts: Required<StaticSoundPlayOptions> = {
            duration: options.duration ?? instance._options.duration,
            loop: options.loop ?? instance._options.loop,
            loopStart: options.loopStart ?? instance._options.loopStart,
            loopEnd: options.loopEnd ?? instance._options.loopEnd,
            pitch: options.pitch ?? instance._options.pitch,
            playbackRate: options.playbackRate ?? instance._options.playbackRate,
            startOffset: options.startOffset ?? instance._options.startOffset,
            volume: options.volume ?? instance._volumeNode.gain.value,
            waitTime: options.waitTime ?? 0,
        };
        _instancePlay(instance, opts);
    }
}

function _instanceStop(instance: SoundInstance, options: StaticSoundStopOptions = {}): void {
    if (instance._state === SoundState.Stopped) {
        return;
    }

    if (instance._state === SoundState.Started) {
        const stopTime = instance._engine.currentTime + (options.waitTime ?? 0);
        instance._sourceNode?.stop(stopTime);
    }

    if (options.waitTime === undefined || options.waitTime <= 0) {
        _setInstanceState(instance, SoundState.Stopped);
        instance._engineStateUnsub?.();
        instance._engineStateUnsub = null;
    }
}

function _instanceDispose(instance: SoundInstance): void {
    _instanceStop(instance);
    _deinitSourceNode(instance);
    instance._engineStateUnsub?.();
    instance._engineStateUnsub = null;
    instance._pitch = null;
    instance._playbackRate = null;
    instance._onEnded._clear();
    instance._onStateChanged._clear();
}

function _onEngineStateChanged(instance: SoundInstance): void {
    if (instance._engine.state !== "running") {
        return;
    }
    if (instance._options.loop && instance._state === SoundState.Starting) {
        const opts: Required<StaticSoundPlayOptions> = {
            duration: instance._options.duration,
            loop: instance._options.loop,
            loopStart: instance._options.loopStart,
            loopEnd: instance._options.loopEnd,
            pitch: instance._options.pitch,
            playbackRate: instance._options.playbackRate,
            startOffset: instance._options.startOffset,
            volume: instance._volumeNode.gain.value,
            waitTime: 0,
        };
        // Reset to a non-started state so `_instancePlay` proceeds.
        instance._state = SoundState.Stopped;
        _instancePlay(instance, opts);
    }
}

function _onInstanceEndedEvent(instance: SoundInstance): void {
    instance._enginePlayTime = 0;
    if (instance._state !== SoundState.Paused) {
        instance._onEnded._notify(instance);
    }
    _deinitSourceNode(instance);
}

function _initSourceNode(instance: SoundInstance): void {
    const sound = instance._sound;
    if (!instance._sourceNode) {
        const sourceNode = new AudioBufferSourceNode(instance._engine._ctx, { buffer: sound._buffer._audioBuffer });
        instance._sourceNode = sourceNode;

        sourceNode.addEventListener("ended", () => _onInstanceEndedEvent(instance), { once: true });
        sourceNode.connect(instance._volumeNode);

        // Connect this instance's output into the sound's sub-graph input.
        instance._volumeNode.connect(sound._graph._in);
        instance._isConnected = true;

        instance._pitch = createRampParam(sourceNode.detune, instance._engine);
        instance._playbackRate = createRampParam(sourceNode.playbackRate, instance._engine);
    }

    const node = instance._sourceNode;
    node.detune.value = instance._options.pitch;
    node.loop = instance._options.loop;
    node.loopEnd = instance._options.loopEnd;
    node.loopStart = instance._options.loopStart;
    node.playbackRate.value = instance._options.playbackRate;
}

function _deinitSourceNode(instance: SoundInstance): void {
    const node = instance._sourceNode;
    if (!node) {
        return;
    }

    if (instance._isConnected) {
        instance._volumeNode.disconnect(instance._sound._graph._in);
        instance._isConnected = false;
    }

    node.disconnect(instance._volumeNode);
    instance._sourceNode = null;
}

/**
 * Sets the detune (pitch) of the newest instance, in cents.
 * Provided for completeness; ramps via the instance's detune param.
 * @internal
 */
export function _setNewestInstancePitch(sound: StaticSound, value: number, options?: RampOptions): void {
    const instance = sound._newest;
    if (instance?._pitch) {
        setRampTarget(instance._pitch, value, options);
    }
}
