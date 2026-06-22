/**
 * Audio engine — lifecycle, master output, default main bus, autoplay unlock.
 *
 * Faithful port of AudioV2 `_WebAudioEngine` + `CreateAudioEngineAsync`,
 * re-shaped to pure state + standalone functions. Re-architected per Babylon
 * Lite pillars:
 *   - No module-level side effects (no `Instances[]`, no module-scope Observable).
 *   - Caller owns the engine handle (no `LastCreatedAudioEngine`).
 *   - `Observable` becomes `AudioSignal`.
 *   - Global hooks (click listener, resume timer) are registered into
 *     `engine._disposers` and torn down on dispose.
 *   - `OfflineAudioContext` is fully supported for deterministic, headless
 *     PCM rendering (the primary audio test gate).
 */

import { type AudioSignal, type AudioSignalImpl, createAudioSignal } from "./audio-signal.js";
import { type RampOptions } from "./audio-param.js";
import { type MainBus, type MainOut, createMainBus, createMainOut, disposeMainBus, disposeMainOut, setMainOutVolume } from "./bus.js";
import type { Vec3 } from "../math/types.js";

/**
 * Minimal structural view of the spatial listener, kept local so this module
 * does NOT import the spatial feature module (Pillar 4: tree-shaking) and so the
 * `.d.ts` rollup has no `AudioEngine` \<-\> `SpatialListener` import cycle. The
 * full listener (assigned by the spatial feature functions) is structurally
 * compatible. @internal
 */
export interface SpatialListenerSlot {
    /** Listener world position, read by source distance attenuation. @internal */ _position: Vec3;
    /** @internal */ _dispose(): void;
}

/** Audio context state, mirroring the Web Audio `AudioContextState` plus `"interrupted"`. */
export type AudioEngineState = "running" | "suspended" | "closed" | "interrupted";

/** Options for {@link createAudioEngineAsync}. */
export interface AudioEngineOptions {
    /**
     * The audio context to use. Pass an `OfflineAudioContext` for deterministic,
     * faster-than-realtime rendering (used by the audio test suite). When omitted
     * a real-time `AudioContext` is created.
     */
    audioContext?: BaseAudioContext;
    /** Master output volume. Defaults to `1`. */
    volume?: number;
    /** Default parameter ramp smoothing, in seconds. Defaults to `0.01`. */
    parameterRampDuration?: number;
    /** Auto-resume the context on user interaction (click). Defaults to `true`. */
    resumeOnInteraction?: boolean;
    /** Auto-resume the context if the browser pauses playback. Defaults to `true`. */
    resumeOnPause?: boolean;
    /** Retry interval (ms) for `resumeOnPause`. Defaults to `1000`. */
    resumeOnPauseRetryInterval?: number;
}

/**
 * A Babylon Lite audio engine. Pure state — operate on it with the audio
 * functions (`createSoundAsync`, `setMasterVolume`, `disposeAudioEngine`, …).
 */
export interface AudioEngine {
    /** Current context state. Always `"running"` for an offline context. */
    readonly state: AudioEngineState;
    /** The audio context's current time, in seconds. */
    readonly currentTime: number;
    /** Fires whenever {@link state} changes. */
    readonly onStateChanged: AudioSignal<AudioEngineState>;
    /** Fires on every qualifying user gesture (click), not just the first. */
    readonly onUserGesture: AudioSignal<void>;

    /** @internal */ readonly _ctx: BaseAudioContext;
    /** @internal */ readonly _isOffline: boolean;
    /** Ramp-clock current time (satisfies `RampClock`). @internal */ readonly _currentTime: number;
    /** Ramp-clock default duration (satisfies `RampClock`). @internal */ _rampDuration: number;
    /** @internal */ _volume: number;
    /** @internal */ _mainOut: MainOut;
    /** @internal */ _mainBus: MainBus;
    /** @internal */ readonly _validFormats: Set<string>;
    /** @internal */ readonly _invalidFormats: Set<string>;
    /** @internal */ readonly _sounds: Set<{ _dispose(): void }>;
    /** @internal */ readonly _buses: Set<{ _dispose(): void }>;
    /** Lazily-built spatial listener (only when spatial audio is used). @internal */ _listener: SpatialListenerSlot | null;
    /** Per-frame spatial update closures, registered while attached. @internal */ readonly _spatialUpdaters: Set<() => void>;
    /** Stops the spatial auto-update loop, if running. @internal */ _spatialAutoStop: (() => void) | null;
    /** @internal */ readonly _disposers: Array<() => void>;
    /** @internal */ readonly _onStateChanged: AudioSignalImpl<AudioEngineState>;
    /** @internal */ readonly _onUserGesture: AudioSignalImpl<void>;
    /** @internal */ readonly _isReady: Promise<void>;
}

const FormatMimeTypes: { [key: string]: string } = {
    aac: "audio/aac",
    ac3: "audio/ac3",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: 'audio/mpeg; codecs="mp3"',
    mp4: "audio/mp4",
    ogg: 'audio/ogg; codecs="vorbis"',
    wav: "audio/wav",
    webm: 'audio/webm; codecs="vorbis"',
};

function isOfflineContext(ctx: BaseAudioContext): boolean {
    return typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
}

/**
 * Creates and initializes an audio engine.
 * @param options - Engine options.
 * @returns A promise that resolves with the ready-to-use engine.
 */
export async function createAudioEngineAsync(options: AudioEngineOptions = {}): Promise<AudioEngine> {
    const ctx = options.audioContext ?? new AudioContext();
    const isOffline = isOfflineContext(ctx);

    const onStateChanged = createAudioSignal<AudioEngineState>();
    const onUserGesture = createAudioSignal<void>();

    let resolveReady!: () => void;
    const isReady = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });

    const engine: AudioEngine = {
        get state(): AudioEngineState {
            return isOffline ? "running" : ((ctx as AudioContext).state as AudioEngineState);
        },
        get currentTime(): number {
            return ctx.currentTime ?? 0;
        },
        get _currentTime(): number {
            return ctx.currentTime ?? 0;
        },
        get onStateChanged(): AudioSignal<AudioEngineState> {
            return onStateChanged;
        },
        get onUserGesture(): AudioSignal<void> {
            return onUserGesture;
        },
        _ctx: ctx,
        _isOffline: isOffline,
        _rampDuration: typeof options.parameterRampDuration === "number" ? Math.max(0, options.parameterRampDuration) : 0.01,
        _volume: options.volume ?? 1,
        // Assigned just below once the engine (the ramp clock) exists.
        _mainOut: undefined as unknown as MainOut,
        _mainBus: undefined as unknown as MainBus,
        _validFormats: new Set<string>(),
        _invalidFormats: new Set<string>(),
        _sounds: new Set<{ _dispose(): void }>(),
        _buses: new Set<{ _dispose(): void }>(),
        _listener: null,
        _spatialUpdaters: new Set<() => void>(),
        _spatialAutoStop: null,
        _disposers: [],
        _onStateChanged: onStateChanged,
        _onUserGesture: onUserGesture,
        _isReady: isReady,
    };

    // Build the output graph: mainBus._volume -> mainOut._gain -> destination.
    engine._mainOut = createMainOut(ctx, engine);
    setMainOutVolume(engine._mainOut, engine._volume);
    engine._mainBus = createMainBus("default", ctx, engine, engine._mainOut);

    _wireStateAndResume(engine, options);
    _wireUserGesture(engine, options);

    resolveReady();
    await isReady;
    return engine;
}

function _wireStateAndResume(engine: AudioEngine, options: AudioEngineOptions): void {
    const ctx = engine._ctx;
    if (engine._isOffline || typeof (ctx as AudioContext).addEventListener !== "function") {
        return;
    }

    const resumeOnPause = options.resumeOnPause !== false;
    const retryInterval = options.resumeOnPauseRetryInterval ?? 1000;

    let started = false;
    let resumeTimer: ReturnType<typeof setInterval> | null = null;

    const clearResumeTimer = (): void => {
        if (resumeTimer !== null) {
            clearInterval(resumeTimer);
            resumeTimer = null;
        }
    };

    const onStateChange = (): void => {
        const state = engine.state;
        if (state === "running") {
            clearResumeTimer();
            started = true;
        } else if ((state === "suspended" || state === "interrupted") && started && resumeOnPause) {
            clearResumeTimer();
            resumeTimer = setInterval(() => {
                void (ctx as AudioContext).resume();
            }, retryInterval);
        }
        engine._onStateChanged._notify(state);
    };

    (ctx as AudioContext).addEventListener("statechange", onStateChange);
    engine._disposers.push(() => {
        clearResumeTimer();
        (ctx as AudioContext).removeEventListener("statechange", onStateChange);
    });
}

function _wireUserGesture(engine: AudioEngine, options: AudioEngineOptions): void {
    const resumeOnInteraction = options.resumeOnInteraction !== false;
    if (engine._isOffline || typeof document === "undefined" || typeof document.addEventListener !== "function") {
        return;
    }

    const onGesture = (): void => {
        if (resumeOnInteraction) {
            void (engine._ctx as AudioContext).resume();
        }
        engine._onUserGesture._notify();
    };

    document.addEventListener("click", onGesture);
    engine._disposers.push(() => document.removeEventListener("click", onGesture));
}

/**
 * Unlocks (resumes) the audio engine. Browsers require a user gesture before a
 * real-time context can produce sound; call this from a click/tap handler.
 * @param engine - The audio engine.
 */
export async function unlockAudioEngineAsync(engine: AudioEngine): Promise<void> {
    if (engine._isOffline) {
        return;
    }
    const ctx = engine._ctx as AudioContext;
    if (ctx.state !== "running") {
        await ctx.resume();
    }
}

/**
 * Sets the master output volume, optionally ramping to the new value.
 * @param engine - The audio engine.
 * @param value - Target volume (1 = unchanged).
 * @param options - Optional ramp shape/duration.
 */
export function setMasterVolume(engine: AudioEngine, value: number, options?: RampOptions): void {
    engine._volume = value;
    setMainOutVolume(engine._mainOut, value, options);
}

/** The master output volume. */
export function getMasterVolume(engine: AudioEngine): number {
    return engine._volume;
}

/**
 * Whether the given audio file format/extension can be decoded by the browser.
 * In non-browser (offline render / test) environments where no `Audio` element
 * exists, the format is assumed valid.
 * @internal
 */
export function isAudioFormatValid(engine: AudioEngine, format: string): boolean {
    if (engine._validFormats.has(format)) {
        return true;
    }
    if (engine._invalidFormats.has(format)) {
        return false;
    }

    const mimeType = FormatMimeTypes[format];
    if (mimeType === undefined) {
        return false;
    }

    if (typeof Audio === "undefined") {
        return true;
    }

    if (new Audio().canPlayType(mimeType) === "") {
        engine._invalidFormats.add(format);
        return false;
    }

    engine._validFormats.add(format);
    return true;
}

/**
 * Disposes the audio engine: stops all sounds, tears down global hooks, and
 * closes the (non-offline) audio context.
 * @param engine - The audio engine to dispose.
 */
export function disposeAudioEngine(engine: AudioEngine): void {
    engine._spatialAutoStop?.();
    engine._spatialAutoStop = null;
    engine._spatialUpdaters.clear();
    engine._listener?._dispose();

    for (const sound of Array.from(engine._sounds)) {
        sound._dispose();
    }
    engine._sounds.clear();

    for (const bus of Array.from(engine._buses)) {
        bus._dispose();
    }
    engine._buses.clear();

    for (const dispose of engine._disposers) {
        try {
            dispose();
        } catch (e) {
            console.warn(`Audio disposer failed: ${(e as Error).message}`);
        }
    }
    engine._disposers.length = 0;

    disposeMainBus(engine._mainBus);
    disposeMainOut(engine._mainOut);

    const ctx = engine._ctx;
    if (!engine._isOffline && (ctx as AudioContext).state !== "closed") {
        void (ctx as AudioContext).close();
    }

    engine._onStateChanged._clear();
    engine._onUserGesture._clear();
}
