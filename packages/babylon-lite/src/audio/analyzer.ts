/**
 * Frequency / amplitude analysis — opt-in feature module.
 *
 * Faithful port of AudioV2 `_AudioAnalyzer` / `_WebAudioAnalyzer`, re-architected
 * to Lite idioms (pure state + standalone functions). Building the sub-node is
 * lazy, so importing nothing from here costs nothing.
 *
 * The analyzer wraps a Web Audio `AnalyserNode`. Mirroring AudioV2
 * `_WebAudioBaseSubGraph._onSubNodesChanged`, it is a passive *tap* off the
 * volume node (`_volume.connect(analyser)`); it is never part of the audible
 * through-chain, so it does not affect the sub-graph head.
 */

import { type AudioEngine } from "./audio-engine.js";
import { type AudioGraphHost, type AudioGraphHostState } from "./host-types.js";

/** Default analyzer settings (match AudioV2 / Web Audio defaults). */
const Defaults = {
    fftSize: 2048,
    minDecibels: -100,
    maxDecibels: -30,
    smoothing: 0.8,
} as const;

/** Options for {@link enableAnalyzer}. */
export interface AudioAnalyzerOptions {
    /** FFT window size (a power of two, `32`–`32768`). Defaults to `2048`. */
    fftSize?: number;
    /** Minimum power value for the dB range, in dBFS. Defaults to `-100`. */
    minDecibels?: number;
    /** Maximum power value for the dB range, in dBFS. Defaults to `-30`. */
    maxDecibels?: number;
    /** Time-averaging constant in `[0, 1]`. Defaults to `0.8`. */
    smoothing?: number;
}

/** Analyzer tap sub-node state. Pure state — driven by the analyzer functions. @internal */
export interface AnalyzerSubNode {
    /** @internal */ _engine: AudioEngine;
    /** @internal */ _node: AnalyserNode;
    /** @internal */ _dispose: () => void;
}

function applyAnalyzerOptions(node: AnalyserNode, options: AudioAnalyzerOptions): void {
    if (options.fftSize !== undefined) {
        node.fftSize = options.fftSize;
    }
    if (options.minDecibels !== undefined) {
        node.minDecibels = options.minDecibels;
    }
    if (options.maxDecibels !== undefined) {
        node.maxDecibels = options.maxDecibels;
    }
    if (options.smoothing !== undefined) {
        node.smoothingTimeConstant = options.smoothing;
    }
}

function createAnalyzerSubNode(engine: AudioEngine, options: AudioAnalyzerOptions): AnalyzerSubNode {
    const node = new AnalyserNode(engine._ctx);
    node.fftSize = Defaults.fftSize;
    node.minDecibels = Defaults.minDecibels;
    node.maxDecibels = Defaults.maxDecibels;
    node.smoothingTimeConstant = Defaults.smoothing;
    applyAnalyzerOptions(node, options);
    return {
        _engine: engine,
        _node: node,
        _dispose: () => {
            node.disconnect();
        },
    };
}

/**
 * Lazily build the analyzer tap and attach it to the host's volume output.
 * Idempotent; re-applies any supplied options to an existing analyzer.
 */
function ensureAnalyzerSubNode(host: AudioGraphHostState, options: AudioAnalyzerOptions = {}): AnalyzerSubNode {
    const graph = host._graph;
    if (graph._analyzer) {
        // The graph stores a structural slot; this feature module owns the full node.
        const existing = graph._analyzer as AnalyzerSubNode;
        applyAnalyzerOptions(existing._node, options);
        return existing;
    }

    const node = createAnalyzerSubNode(host._engine, options);
    graph._volume.connect(node._node);
    graph._analyzer = node;
    return node;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Enables (or reconfigures) frequency/amplitude analysis on a sound or bus,
 * building the analyzer tap on first use. Pulls the analyzer module only when
 * called.
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param options - Analyzer options (fftSize, dB range, smoothing).
 */
export function enableAnalyzer(host: AudioGraphHost, options: AudioAnalyzerOptions = {}): void {
    ensureAnalyzerSubNode(host, options);
}

/**
 * Writes the current frequency-domain data as unsigned bytes into `out`,
 * building the analyzer tap on first use. `out` should be sized to the
 * analyzer's `frequencyBinCount` (`fftSize / 2`).
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param out - Destination buffer; values are written in place.
 */
export function getByteFrequencyData(host: AudioGraphHost, out: Uint8Array): void {
    ensureAnalyzerSubNode(host)._node.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
}

/**
 * Writes the current frequency-domain data as floats (in dBFS) into `out`,
 * building the analyzer tap on first use. `out` should be sized to the
 * analyzer's `frequencyBinCount` (`fftSize / 2`).
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param out - Destination buffer; values are written in place.
 */
export function getFloatFrequencyData(host: AudioGraphHost, out: Float32Array): void {
    ensureAnalyzerSubNode(host)._node.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
}

/**
 * Writes the current time-domain (waveform) data as unsigned bytes into `out`,
 * building the analyzer tap on first use. Each sample is centered on `128`.
 * `out` should be sized to the analyzer's `fftSize`.
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param out - Destination buffer; values are written in place.
 */
export function getByteTimeDomainData(host: AudioGraphHost, out: Uint8Array): void {
    ensureAnalyzerSubNode(host)._node.getByteTimeDomainData(out as Uint8Array<ArrayBuffer>);
}

/**
 * Writes the current time-domain (waveform) data as floats in `[-1, 1]` into
 * `out`, building the analyzer tap on first use. `out` should be sized to the
 * analyzer's `fftSize`.
 * @param host - A `StaticSound`, `StreamingSound`, or `AudioBus`.
 * @param out - Destination buffer; values are written in place.
 */
export function getFloatTimeDomainData(host: AudioGraphHost, out: Float32Array): void {
    ensureAnalyzerSubNode(host)._node.getFloatTimeDomainData(out as Float32Array<ArrayBuffer>);
}
