/**
 * Streaming sounds (HTMLMediaElement-backed) and their play instances.
 *
 * Faithful port of AudioV2 `StreamingSound` / `_WebAudioStreamingSound`
 * (+ `_StreamingSoundInstance`), collapsed to pure state + standalone functions.
 *
 * A streaming sound plays an `<audio>` element through a
 * `MediaElementAudioSourceNode`, so the media is fetched/decoded in chunks by
 * the browser as it plays. This is cheaper to start for large/long assets than
 * a fully-decoded {@link StaticSound}, but it cannot have loop points, pitch, or
 * playback-rate changes.
 *
 * Graph per playing instance:
 *
 * `<audio>` becomes `MediaElementAudioSourceNode` then `instance._volumeNode`
 * then `sound._graph._in` then `sound._graph._out` then the output bus, the main
 * bus, the main out, and finally `ctx.destination`.
 *
 * Because the first play of a streaming sound can be delayed while the media
 * buffers, instances can be pre-loaded (`preloadCount`, or
 * {@link preloadStreamingInstanceAsync}) so playback starts immediately.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type PrimaryAudioBus, getBusInputNode } from "./audio-bus.js";
import { cleanAudioUrl } from "./audio-fetch.js";
import { type RampOptions } from "./audio-param.js";
import { type AudioSignal, type AudioSignalImpl, createAudioSignal } from "./audio-signal.js";
import { SoundState } from "./static-sound.js";
import { type SoundSubGraph, connectSoundSubGraph, createSoundSubGraph, disposeSoundSubGraph, setSoundSubGraphVolume } from "./sound-sub-graph.js";

/** A streaming sound source: a URL, a list of candidate URLs, or an existing media element. */
export type StreamingSoundSource = string | string[] | HTMLMediaElement;

/** Options for {@link createStreamingSoundAsync}. */
export interface StreamingSoundOptions {
    /** Play immediately once ready. Defaults to `false`. */
    autoplay?: boolean;
    /** Loop playback. Defaults to `false`. */
    loop?: boolean;
    /** Maximum simultaneous instances. Defaults to `Infinity`. */
    maxInstances?: number;
    /** Output bus. Defaults to the engine's default main bus. */
    outBus?: PrimaryAudioBus;
    /** Number of instances to preload. Defaults to `1`. */
    preloadCount?: number;
    /** Start offset in seconds. Defaults to `0`. */
    startOffset?: number;
    /** Initial volume. Defaults to `1`. */
    volume?: number;
}

/** Per-play overrides for {@link playStreamingSound}. */
export interface StreamingSoundPlayOptions {
    /** Loop playback. */
    loop?: boolean;
    /** Start offset in seconds. */
    startOffset?: number;
    /** Per-instance volume. */
    volume?: number;
}

interface StoredStreamingOptions {
    autoplay: boolean;
    loop: boolean;
    maxInstances: number;
    preloadCount: number;
    startOffset: number;
}

/** A streaming, media-element-backed sound. Pure state — drive it with the streaming-sound functions. */
export interface StreamingSound {
    /** Optional name. */
    readonly name?: string;
    /** Current playback state. */
    readonly state: SoundState;
    /** Number of live instances. */
    readonly instanceCount: number;
    /** Number of instances that have finished preloading. */
    readonly preloadCompletedCount: number;
    /** Fires when the sound finishes (all instances ended). */
    readonly onEnded: AudioSignal<StreamingSound>;

    /** @internal */ _engine: AudioEngine;
    /** @internal */ _source: StreamingSoundSource;
    /** @internal */ _graph: SoundSubGraph;
    /** @internal */ _outBus: PrimaryAudioBus;
    /** @internal */ _options: StoredStreamingOptions;
    /** @internal */ _instances: Set<StreamingInstance>;
    /** @internal */ _preloaded: StreamingInstance[];
    /** @internal */ _newest: StreamingInstance | null;
    /** @internal */ _state: SoundState;
    /** @internal */ _onEnded: AudioSignalImpl<StreamingSound>;
    /** @internal */ _dispose(): void;
}

/** A single in-flight playback of a {@link StreamingSound}. @internal */
export interface StreamingInstance {
    /** @internal */ _sound: StreamingSound;
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _options: { loop: boolean; startOffset: number };
    /** @internal */ _mediaElement: HTMLMediaElement;
    /** @internal */ _sourceNode: MediaElementAudioSourceNode | null;
    /** @internal */ _volumeNode: GainNode;
    /** @internal */ _state: SoundState;
    /** @internal */ _enginePlayTime: number;
    /** @internal */ _enginePauseTime: number;
    /** @internal */ _isReady: boolean;
    /** @internal */ _readyPromise: Promise<void>;
    /** @internal */ _resolveReady: () => void;
    /** @internal */ _rejectReady: (reason?: unknown) => void;
    /** @internal */ _preloadedPromise: Promise<void>;
    /** @internal */ _engineStateUnsub: (() => void) | null;
    /** @internal */ _userGestureUnsub: (() => void) | null;
    /** @internal */ _onEnded: AudioSignalImpl<StreamingInstance>;
    /** @internal */ _onStateChanged: AudioSignalImpl<StreamingInstance>;
    /** @internal */ _endedHandler: () => void;
    /** @internal */ _canPlayThroughHandler: () => void;
    /** @internal */ _mediaEndedHandler: () => void;
    /** @internal */ _errorHandler: (reason?: unknown) => void;
    /** @internal */ _engineStateHandler: () => void;
    /** @internal */ _userGestureHandler: () => void;
}

/**
 * Creates a streaming, media-element-backed sound routed to the given output bus
 * (or the engine's default main bus). Requires a real-time `AudioContext`.
 * @param engine - The audio engine.
 * @param source - A URL, a list of candidate URLs, or an `HTMLMediaElement`.
 * @param options - Streaming sound options.
 * @returns A promise that resolves with the ready sound.
 */
export async function createStreamingSoundAsync(engine: AudioEngine, source: StreamingSoundSource, options: StreamingSoundOptions = {}): Promise<StreamingSound> {
    if (engine._isOffline) {
        throw new Error("Streaming sounds require a real-time AudioContext.");
    }

    await engine._isReady;

    const graph = createSoundSubGraph(engine._ctx, engine, options.volume ?? 1);
    const outBus = options.outBus ?? engine._mainBus;
    connectSoundSubGraph(graph, getBusInputNode(outBus));

    const onEnded = createAudioSignal<StreamingSound>();

    const sound: StreamingSound = {
        get state() {
            return sound._state;
        },
        get instanceCount() {
            return sound._instances.size;
        },
        get preloadCompletedCount() {
            return sound._preloaded.length;
        },
        get onEnded(): AudioSignal<StreamingSound> {
            return onEnded;
        },
        _engine: engine,
        _source: source,
        _graph: graph,
        _outBus: outBus,
        _options: {
            autoplay: options.autoplay ?? false,
            loop: options.loop ?? false,
            maxInstances: options.maxInstances ?? Infinity,
            preloadCount: options.preloadCount ?? 1,
            startOffset: options.startOffset ?? 0,
        },
        _instances: new Set<StreamingInstance>(),
        _preloaded: [],
        _newest: null,
        _state: SoundState.Stopped,
        _onEnded: onEnded,
        _dispose: () => disposeStreamingSound(sound),
    };

    engine._sounds.add(sound);

    if (sound._options.preloadCount > 0) {
        await preloadStreamingInstancesAsync(sound, sound._options.preloadCount);
    }

    if (sound._options.autoplay) {
        playStreamingSound(sound);
    }

    return sound;
}

/** Preloads a single instance of the sound and resolves once it can play through. */
export function preloadStreamingInstanceAsync(sound: StreamingSound): Promise<void> {
    const instance = _createStreamingInstance(sound);
    if (!sound._preloaded.includes(instance)) {
        sound._preloaded.push(instance);
    }
    return instance._preloadedPromise;
}

/** Preloads the given number of instances and resolves once all can play through. */
export async function preloadStreamingInstancesAsync(sound: StreamingSound, count: number): Promise<void> {
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < count; i++) {
        promises.push(preloadStreamingInstanceAsync(sound));
    }
    await Promise.all(promises);
}

/**
 * Plays the streaming sound. Reuses a preloaded instance when available,
 * otherwise spawns a new one (subject to `maxInstances`). A paused sound is
 * resumed instead.
 * @param sound - The sound to play.
 * @param options - Per-play overrides.
 */
export function playStreamingSound(sound: StreamingSound, options: StreamingSoundPlayOptions = {}): void {
    if (sound._state === SoundState.Paused) {
        resumeStreamingSound(sound, options);
        return;
    }

    let instance: StreamingInstance;
    if (sound._preloaded.length > 0) {
        instance = sound._preloaded[0]!;
        instance._options.startOffset = sound._options.startOffset;
        _removePreloaded(sound, instance);
    } else {
        instance = _createStreamingInstance(sound);
    }

    instance._onEnded.addOnce(instance._endedHandler);
    sound._instances.add(instance);
    sound._newest = instance;

    const onStateChanged = (): void => {
        if (instance._state === SoundState.Started) {
            _stopExcessInstances(sound);
            unsubStateChanged();
        }
    };
    const unsubStateChanged = instance._onStateChanged.add(onStateChanged);

    const opts: Required<StreamingSoundPlayOptions> = {
        loop: options.loop ?? sound._options.loop,
        startOffset: options.startOffset ?? sound._options.startOffset,
        volume: options.volume ?? 1,
    };

    _instancePlay(instance, opts);
    sound._state = instance._state;
}

/** Pauses all of the sound's instances. */
export function pauseStreamingSound(sound: StreamingSound): void {
    for (const instance of sound._instances) {
        _instancePause(instance);
    }
    sound._state = SoundState.Paused;
}

/** Resumes a paused streaming sound. */
export function resumeStreamingSound(sound: StreamingSound, options: StreamingSoundPlayOptions = {}): void {
    if (sound._state !== SoundState.Paused) {
        return;
    }
    for (const instance of sound._instances) {
        _instanceResume(instance, options);
    }
    sound._state = SoundState.Started;
}

/** Stops the sound (and all its instances). */
export function stopStreamingSound(sound: StreamingSound): void {
    sound._state = SoundState.Stopped;
    for (const instance of Array.from(sound._instances)) {
        _instanceStop(instance);
    }
}

/** Sets the sound's output volume, optionally ramping. */
export function setStreamingSoundVolume(sound: StreamingSound, value: number, options?: RampOptions): void {
    setSoundSubGraphVolume(sound._graph, value, options);
}

/** Disposes the sound, stopping playback and releasing its graph and preloaded instances. */
export function disposeStreamingSound(sound: StreamingSound): void {
    stopStreamingSound(sound);
    for (const instance of Array.from(sound._instances)) {
        _instanceDispose(instance);
    }
    sound._instances.clear();
    for (const instance of sound._preloaded.slice()) {
        _instanceDispose(instance);
    }
    sound._preloaded.length = 0;
    disposeSoundSubGraph(sound._graph);
    sound._onEnded._clear();
    sound._engine._sounds.delete(sound);
}

function _stopExcessInstances(sound: StreamingSound): void {
    if (sound._options.maxInstances < Infinity) {
        const started = Array.from(sound._instances).filter((i) => i._state === SoundState.Started);
        const toStop = started.length - sound._options.maxInstances;
        for (let i = 0; i < toStop; i++) {
            _instanceStop(started[i]!);
        }
    }
}

function _removePreloaded(sound: StreamingSound, instance: StreamingInstance): void {
    const index = sound._preloaded.indexOf(instance);
    if (index !== -1) {
        sound._preloaded.splice(index, 1);
    }
}

function _onInstanceEnded(sound: StreamingSound, instance: StreamingInstance): void {
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

function _createStreamingInstance(sound: StreamingSound): StreamingInstance {
    const engine = sound._engine;

    let resolveReady!: () => void;
    let rejectReady!: (reason?: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    const instance: StreamingInstance = {
        _sound: sound,
        _engine: engine,
        _options: {
            loop: sound._options.loop,
            startOffset: sound._options.startOffset,
        },
        _mediaElement: undefined as unknown as HTMLMediaElement,
        _sourceNode: null,
        _volumeNode: new GainNode(engine._ctx),
        _state: SoundState.Stopped,
        _enginePlayTime: Infinity,
        _enginePauseTime: 0,
        _isReady: false,
        _readyPromise: readyPromise,
        _resolveReady: resolveReady,
        _rejectReady: rejectReady,
        // The preloaded promise resolves on ready and rejects on error.
        _preloadedPromise: readyPromise,
        _engineStateUnsub: null,
        _userGestureUnsub: null,
        _onEnded: createAudioSignal<StreamingInstance>(),
        _onStateChanged: createAudioSignal<StreamingInstance>(),
        _endedHandler: () => _onInstanceEnded(sound, instance),
        _canPlayThroughHandler: () => _onCanPlayThrough(instance),
        _mediaEndedHandler: () => _onMediaEnded(instance),
        _errorHandler: (reason?: unknown) => _onMediaError(instance, reason),
        _engineStateHandler: () => _onEngineStateChanged(instance),
        _userGestureHandler: () => _instancePlay(instance, { loop: instance._options.loop, startOffset: instance._options.startOffset, volume: instance._volumeNode.gain.value }),
    };

    _initMediaElement(instance);
    return instance;
}

function _initMediaElement(instance: StreamingInstance): void {
    const source = instance._sound._source;
    let mediaElement: HTMLMediaElement;

    if (typeof source === "string") {
        mediaElement = new Audio(cleanAudioUrl(source));
    } else if (Array.isArray(source)) {
        mediaElement = new Audio();
        for (const url of source) {
            const sourceEl = document.createElement("source");
            sourceEl.src = cleanAudioUrl(url);
            mediaElement.appendChild(sourceEl);
        }
    } else {
        mediaElement = source;
    }

    // Babylon Lite default: request CORS so cross-origin media can be routed
    // through Web Audio (adaptation of AudioV2's Tools.SetCorsBehavior).
    mediaElement.crossOrigin = "anonymous";
    mediaElement.controls = false;
    mediaElement.loop = instance._options.loop;
    mediaElement.preload = "auto";

    mediaElement.addEventListener("canplaythrough", instance._canPlayThroughHandler, { once: true });
    mediaElement.addEventListener("ended", instance._mediaEndedHandler, { once: true });
    mediaElement.addEventListener("error", instance._errorHandler, { once: true });

    mediaElement.load();

    const sourceNode = new MediaElementAudioSourceNode(instance._engine._ctx as AudioContext, { mediaElement });
    sourceNode.connect(instance._volumeNode);
    instance._volumeNode.connect(instance._sound._graph._in);

    instance._sourceNode = sourceNode;
    instance._mediaElement = mediaElement;
}

function _setStreamingInstanceState(instance: StreamingInstance, state: SoundState): void {
    instance._state = state;
    instance._onStateChanged._notify(instance);
}

function _instanceCurrentTime(instance: StreamingInstance): number {
    if (instance._state === SoundState.Stopped) {
        return 0;
    }
    const timeSinceLastStart = instance._state === SoundState.Paused ? 0 : instance._engine.currentTime - instance._enginePlayTime;
    return instance._enginePauseTime + timeSinceLastStart + instance._options.startOffset;
}

function _instancePlay(instance: StreamingInstance, options: Required<StreamingSoundPlayOptions>): void {
    if (instance._state === SoundState.Started) {
        return;
    }

    instance._options.loop = options.loop;
    instance._mediaElement.loop = options.loop;

    let startOffset = options.startOffset;
    if (instance._state === SoundState.Paused) {
        startOffset = _instanceCurrentTime(instance);
    }
    if (startOffset > 0) {
        instance._mediaElement.currentTime = startOffset;
    }

    instance._volumeNode.gain.value = options.volume;

    _play(instance);
}

function _instancePause(instance: StreamingInstance): void {
    if (instance._state !== SoundState.Starting && instance._state !== SoundState.Started) {
        return;
    }
    _setStreamingInstanceState(instance, SoundState.Paused);
    instance._enginePauseTime += instance._engine.currentTime - instance._enginePlayTime;
    instance._mediaElement.pause();
}

function _instanceResume(instance: StreamingInstance, options: StreamingSoundPlayOptions): void {
    if (instance._state !== SoundState.Paused) {
        return;
    }
    _instancePlay(instance, {
        loop: options.loop ?? instance._options.loop,
        startOffset: options.startOffset ?? instance._options.startOffset,
        volume: options.volume ?? instance._volumeNode.gain.value,
    });
}

function _instanceStop(instance: StreamingInstance): void {
    if (instance._state === SoundState.Stopped) {
        return;
    }
    instance._mediaElement.pause();
    _onMediaEnded(instance);
    instance._engineStateUnsub?.();
    instance._engineStateUnsub = null;
}

function _instanceDispose(instance: StreamingInstance): void {
    _instanceStop(instance);

    instance._sourceNode?.disconnect(instance._volumeNode);
    instance._sourceNode = null;
    instance._volumeNode.disconnect();

    const mediaElement = instance._mediaElement;
    if (mediaElement) {
        mediaElement.removeEventListener("canplaythrough", instance._canPlayThroughHandler);
        mediaElement.removeEventListener("ended", instance._mediaEndedHandler);
        mediaElement.removeEventListener("error", instance._errorHandler);
    }

    instance._engineStateUnsub?.();
    instance._engineStateUnsub = null;
    instance._userGestureUnsub?.();
    instance._userGestureUnsub = null;

    // Resolve any still-pending preload waiters so disposal never hangs.
    instance._resolveReady();
    instance._onEnded._clear();
    instance._onStateChanged._clear();
}

function _onCanPlayThrough(instance: StreamingInstance): void {
    instance._isReady = true;
    instance._resolveReady();
}

function _onMediaEnded(instance: StreamingInstance): void {
    // Capture the state before the transition: `_setStreamingInstanceState`
    // overwrites `_state` to `Stopped`, so the paused check must read it first.
    const wasPaused = instance._state === SoundState.Paused;
    _setStreamingInstanceState(instance, SoundState.Stopped);
    if (!wasPaused) {
        instance._onEnded._notify(instance);
    }
}

function _onMediaError(instance: StreamingInstance, reason?: unknown): void {
    _setStreamingInstanceState(instance, SoundState.FailedToStart);
    instance._rejectReady(reason);
    _instanceDispose(instance);
}

function _onEngineStateChanged(instance: StreamingInstance): void {
    if (instance._engine.state !== "running") {
        return;
    }
    if (instance._options.loop && instance._state === SoundState.Starting) {
        _instancePlay(instance, { loop: instance._options.loop, startOffset: instance._options.startOffset, volume: instance._volumeNode.gain.value });
    }
    instance._engineStateUnsub?.();
    instance._engineStateUnsub = null;
}

function _play(instance: StreamingInstance): void {
    _setStreamingInstanceState(instance, SoundState.Starting);

    if (!instance._isReady) {
        void _playWhenReady(instance);
        return;
    }
    if (instance._state !== SoundState.Starting) {
        return;
    }

    if (instance._engine.state === "running") {
        const result = instance._mediaElement.play() as Promise<void> | undefined;
        instance._enginePlayTime = instance._engine.currentTime;
        _setStreamingInstanceState(instance, SoundState.Started);
        if (result && typeof result.then === "function") {
            void _awaitPlayResult(instance, result);
        }
    } else if (instance._options.loop) {
        instance._engineStateUnsub = instance._engine.onStateChanged.add(instance._engineStateHandler);
    } else {
        _instanceStop(instance);
        _setStreamingInstanceState(instance, SoundState.FailedToStart);
    }
}

async function _playWhenReady(instance: StreamingInstance): Promise<void> {
    try {
        await instance._readyPromise;
        _play(instance);
    } catch {
        _setStreamingInstanceState(instance, SoundState.FailedToStart);
    }
}

async function _awaitPlayResult(instance: StreamingInstance, result: Promise<void>): Promise<void> {
    try {
        await result;
    } catch {
        // Playback can fail even when the engine reports "running" (e.g. an OS
        // auto-resume without a user gesture). Recover on the next gesture.
        _setStreamingInstanceState(instance, SoundState.FailedToStart);
        if (instance._options.loop) {
            instance._userGestureUnsub = instance._engine.onUserGesture.addOnce(instance._userGestureHandler);
        }
    }
}
