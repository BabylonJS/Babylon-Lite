/**
 * Tier-2/3 real-Web-Audio test harness.
 *
 * These tests render Babylon Lite sounds through a REAL `OfflineAudioContext`
 * provided by the optional native dev dependency `node-web-audio-api`, then
 * assert on the resulting PCM (Tier-2) or on a canvas drawing of that PCM
 * (Tier-3). Unlike the `tests/lite/unit/audio/*` suite — which runs against a
 * pure JS Web Audio mock — these exercise the engine's actual signal graph.
 *
 * The native dependency is OPT-IN: if `node-web-audio-api` cannot be loaded on
 * the current platform, {@link realWebAudioAvailable} is `false` and every
 * offline/visual spec self-skips via `describe.skipIf(!realWebAudioAvailable)`,
 * so install and CI never hard-fail on a missing prebuilt binary.
 */

import { createAudioEngineAsync, disposeAudioEngine, type AudioEngine } from "../../../../packages/babylon-lite/src/audio/index.js";

// Web Audio constructors the engine builds nodes with (`new GainNode(ctx)`,
// `new AudioBufferSourceNode(ctx)`, …). In a browser these are globals; under
// Node we install `node-web-audio-api`'s implementations as globals for the
// duration of a render.
const GLOBAL_KEYS = [
    "OfflineAudioContext",
    "AudioContext",
    "BaseAudioContext",
    "AudioBuffer",
    "AudioNode",
    "AudioParam",
    "AudioListener",
    "GainNode",
    "AudioBufferSourceNode",
    "AnalyserNode",
    "PannerNode",
    "StereoPannerNode",
] as const;

type Nwa = typeof import("node-web-audio-api");

let nwa: Nwa | null = null;
try {
    nwa = await import("node-web-audio-api");
} catch {
    nwa = null;
}

/** `true` when `node-web-audio-api` loaded and real offline rendering is possible. */
export const realWebAudioAvailable: boolean = nwa !== null;

/**
 * Installs `node-web-audio-api`'s Web Audio classes as globals so the engine's
 * `new GainNode(ctx)`-style construction resolves to the native implementation.
 * @returns A restore function that puts the previous globals back.
 */
function installRealWebAudioGlobals(): () => void {
    if (nwa === null) {
        throw new Error("node-web-audio-api is not available");
    }
    const g = globalThis as Record<string, unknown>;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const key of GLOBAL_KEYS) {
        saved.set(key, Object.getOwnPropertyDescriptor(g, key));
        Object.defineProperty(g, key, {
            configurable: true,
            writable: true,
            value: (nwa as unknown as Record<string, unknown>)[key],
        });
    }
    return () => {
        for (const key of GLOBAL_KEYS) {
            const prev = saved.get(key);
            if (prev) {
                Object.defineProperty(g, key, prev);
            } else {
                delete g[key];
            }
        }
    };
}

/** Result of an offline render: per-channel Float32 PCM plus metadata. */
export interface OfflineRenderResult {
    /** Sample rate of the rendered PCM, in Hz. */
    sampleRate: number;
    /** One Float32Array of samples per output channel. */
    channels: Float32Array[];
    /** First channel (mono / left). Always present. */
    mono: Float32Array;
    /** Left channel. Alias of {@link mono}. */
    left: Float32Array;
    /** Right channel. Falls back to the left channel for a mono render. */
    right: Float32Array;
    /** Rendered duration, in seconds. */
    duration: number;
}

/** Options for {@link renderOffline}. */
export interface RenderOfflineOptions {
    /** Render length, in seconds. */
    seconds: number;
    /** Output sample rate. Defaults to `44100`. */
    sampleRate?: number;
    /** Output channel count. Defaults to `2`. */
    channels?: number;
    /**
     * Builds the audio graph to render. Create and play sounds against the
     * supplied engine; everything scheduled before this resolves is captured.
     */
    setup: (engine: AudioEngine, ctx: OfflineAudioContext) => Promise<void> | void;
}

/**
 * Renders a Babylon Lite audio graph through a real `OfflineAudioContext` and
 * returns the resulting PCM.
 * @param options - Render length plus the graph-building `setup` callback.
 * @returns The rendered per-channel PCM.
 */
export async function renderOffline(options: RenderOfflineOptions): Promise<OfflineRenderResult> {
    const sampleRate = options.sampleRate ?? 44100;
    const channels = options.channels ?? 2;
    const length = Math.max(1, Math.ceil(options.seconds * sampleRate));
    const restore = installRealWebAudioGlobals();
    try {
        const ctx = new OfflineAudioContext(channels, length, sampleRate);
        const engine = await createAudioEngineAsync({ audioContext: ctx });
        await options.setup(engine, ctx);
        const rendered = await ctx.startRendering();
        disposeAudioEngine(engine);
        const out: Float32Array[] = [];
        for (let c = 0; c < rendered.numberOfChannels; c++) {
            out.push(rendered.getChannelData(c).slice());
        }
        const mono = out[0] ?? new Float32Array(length);
        return { sampleRate, channels: out, mono, left: mono, right: out[1] ?? mono, duration: options.seconds };
    } finally {
        restore();
    }
}

/**
 * Builds a mono `AudioBuffer` filled with a sine tone, for use as a sound
 * source in a render. Must be called while real-Web-Audio globals are installed
 * (i.e. inside a {@link renderOffline} `setup` callback).
 * @param ctx - The offline context to allocate the buffer in.
 * @param frequency - Tone frequency, in Hz.
 * @param seconds - Buffer length, in seconds.
 * @param amplitude - Peak amplitude in `[0, 1]`. Defaults to `0.5`.
 * @returns The filled buffer.
 */
export function makeSineBuffer(ctx: BaseAudioContext, frequency: number, seconds: number, amplitude = 0.5): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.max(1, Math.ceil(seconds * sampleRate));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
        data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    }
    return buffer;
}

/** Peak absolute sample value of a channel. */
export function peak(channel: Float32Array): number {
    let max = 0;
    for (let i = 0; i < channel.length; i++) {
        const v = Math.abs(channel[i]!);
        if (v > max) {
            max = v;
        }
    }
    return max;
}

/** Root-mean-square (energy) of a channel. */
export function rms(channel: Float32Array): number {
    if (channel.length === 0) {
        return 0;
    }
    let sumSq = 0;
    for (let i = 0; i < channel.length; i++) {
        sumSq += channel[i]! * channel[i]!;
    }
    return Math.sqrt(sumSq / channel.length);
}

/** RMS over the half-open sample window `[startSec, endSec)` of a channel. */
export function rmsWindow(channel: Float32Array, sampleRate: number, startSec: number, endSec: number): number {
    const start = Math.max(0, Math.floor(startSec * sampleRate));
    const end = Math.min(channel.length, Math.ceil(endSec * sampleRate));
    if (end <= start) {
        return 0;
    }
    let sumSq = 0;
    for (let i = start; i < end; i++) {
        sumSq += channel[i]! * channel[i]!;
    }
    return Math.sqrt(sumSq / (end - start));
}
