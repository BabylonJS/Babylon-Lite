/**
 * Real-time audio visualizer — opt-in demo helper.
 *
 * Draws a frequency-bar + waveform display from an {@link AnalyzerSubNode} tap
 * to a 2D `<canvas>`. This is a Lite-specific presentation helper — Babylon.js
 * AudioV2 has no canvas visualizer — so it is intentional adaptation glue, not a
 * port. It builds on the faithful analyzer port (Phase 5) and is fully
 * tree-shakable: importing nothing from here costs nothing, and the module is
 * never referenced by the core sound/bus/engine modules.
 *
 * The render loop uses `requestAnimationFrame` when available; a single frame can
 * also be drawn directly via {@link renderAudioVisualizerFrame} (used in tests).
 */

import { enableAnalyzer, getByteFrequencyData, getByteTimeDomainData } from "./analyzer.js";
import { type AudioGraphHost } from "./host-types.js";

/** What to draw in the visualizer. */
export type AudioVisualizerMode = "bars" | "waveform" | "both";

/** Default visualizer settings. */
const Defaults = {
    fftSize: 2048,
    smoothing: 0.8,
    mode: "both" as AudioVisualizerMode,
    backgroundColor: "#101014",
    barColor: "#4fc3f7",
    waveformColor: "#ffffff",
} as const;

/** Options for {@link createAudioVisualizer}. */
export interface AudioVisualizerOptions {
    /** FFT window size (a power of two). Defaults to `2048`. */
    fftSize?: number;
    /** Analyzer time-averaging constant in `[0, 1]`. Defaults to `0.8`. */
    smoothing?: number;
    /** What to draw. Defaults to `"both"`. */
    mode?: AudioVisualizerMode;
    /** Canvas background fill. Defaults to `"#101014"`. */
    backgroundColor?: string;
    /** Frequency-bar color. Defaults to `"#4fc3f7"`. */
    barColor?: string;
    /** Waveform line color. Defaults to `"#ffffff"`. */
    waveformColor?: string;
}

/** Visualizer state. Pure state — driven by the visualizer functions. */
export interface AudioVisualizer {
    /** The canvas being drawn to. */
    readonly canvas: HTMLCanvasElement;
    /** @internal */ _host: AudioGraphHost;
    /** @internal */ _ctx2d: CanvasRenderingContext2D;
    /** @internal */ _mode: AudioVisualizerMode;
    /** @internal */ _bgColor: string;
    /** @internal */ _barColor: string;
    /** @internal */ _waveColor: string;
    /** @internal */ _freq: Uint8Array;
    /** @internal */ _time: Uint8Array;
    /** @internal */ _raf: number | null;
    /** @internal */ _dispose(): void;
}

/**
 * Creates a real-time visualizer that taps the host's analyzer and draws to the
 * given canvas. Enables the analyzer on the host if it is not already enabled.
 * Call {@link startAudioVisualizer} to begin the animation loop.
 * @param host - A `StaticSound`, `StreamingSound`, `AudioBus`, or input source.
 * @param canvas - The destination 2D canvas.
 * @param options - Visualizer options.
 * @returns The visualizer handle; dispose it with {@link disposeAudioVisualizer}.
 * @throws If a 2D context cannot be obtained from the canvas.
 */
export function createAudioVisualizer(host: AudioGraphHost, canvas: HTMLCanvasElement, options: AudioVisualizerOptions = {}): AudioVisualizer {
    const fftSize = options.fftSize ?? Defaults.fftSize;
    enableAnalyzer(host, { fftSize, smoothing: options.smoothing ?? Defaults.smoothing });

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
        throw new Error("Unable to get a 2D context from the visualizer canvas.");
    }

    const viz: AudioVisualizer = {
        canvas,
        _host: host,
        _ctx2d: ctx2d,
        _mode: options.mode ?? Defaults.mode,
        _bgColor: options.backgroundColor ?? Defaults.backgroundColor,
        _barColor: options.barColor ?? Defaults.barColor,
        _waveColor: options.waveformColor ?? Defaults.waveformColor,
        _freq: new Uint8Array(fftSize / 2),
        _time: new Uint8Array(fftSize),
        _raf: null,
        _dispose: () => disposeAudioVisualizer(viz),
    };
    return viz;
}

function drawBars(viz: AudioVisualizer, width: number, height: number): void {
    const ctx = viz._ctx2d;
    const bins = viz._freq;
    getByteFrequencyData(viz._host, bins);
    const count = bins.length;
    const barWidth = width / count;
    ctx.fillStyle = viz._barColor;
    for (let i = 0; i < count; i++) {
        const magnitude = bins[i]! / 255;
        const barHeight = magnitude * height;
        ctx.fillRect(i * barWidth, height - barHeight, Math.max(barWidth - 1, 1), barHeight);
    }
}

function drawWaveform(viz: AudioVisualizer, width: number, height: number): void {
    const ctx = viz._ctx2d;
    const samples = viz._time;
    getByteTimeDomainData(viz._host, samples);
    const count = samples.length;
    const step = width / count;
    ctx.lineWidth = 2;
    ctx.strokeStyle = viz._waveColor;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
        // Byte time-domain data is centered on 128; map to [0, height].
        const y = (samples[i]! / 255) * height;
        const x = i * step;
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
}

/**
 * Draws a single visualizer frame from the current analyzer data. Safe to call
 * directly (e.g. from a custom loop or a test) without starting the built-in
 * animation loop.
 * @param viz - The visualizer handle.
 */
export function renderAudioVisualizerFrame(viz: AudioVisualizer): void {
    const { width, height } = viz.canvas;
    const ctx = viz._ctx2d;
    ctx.fillStyle = viz._bgColor;
    ctx.fillRect(0, 0, width, height);

    if (viz._mode === "bars" || viz._mode === "both") {
        drawBars(viz, width, height);
    }
    if (viz._mode === "waveform" || viz._mode === "both") {
        drawWaveform(viz, width, height);
    }
}

/**
 * Starts the `requestAnimationFrame` render loop. No-op if already running or if
 * `requestAnimationFrame` is unavailable (e.g. a non-browser environment).
 * @param viz - The visualizer handle.
 */
export function startAudioVisualizer(viz: AudioVisualizer): void {
    if (viz._raf !== null || typeof requestAnimationFrame !== "function") {
        return;
    }
    const loop = () => {
        renderAudioVisualizerFrame(viz);
        viz._raf = requestAnimationFrame(loop);
    };
    viz._raf = requestAnimationFrame(loop);
}

/**
 * Stops the render loop if it is running.
 * @param viz - The visualizer handle.
 */
export function stopAudioVisualizer(viz: AudioVisualizer): void {
    if (viz._raf !== null) {
        if (typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(viz._raf);
        }
        viz._raf = null;
    }
}

/**
 * Stops the render loop and releases the visualizer. The underlying analyzer tap
 * stays on the host (dispose the host to release it).
 * @param viz - The visualizer handle.
 */
export function disposeAudioVisualizer(viz: AudioVisualizer): void {
    stopAudioVisualizer(viz);
}
