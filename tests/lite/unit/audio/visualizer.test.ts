import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installWebAudioMock, uninstallWebAudioMock, MockAudioContext, MockCanvas } from "./web-audio-mock.js";
import { createAudioEngineAsync, disposeAudioEngine } from "../../../../packages/babylon-lite/src/audio/audio-engine.js";
import { createAudioBusAsync } from "../../../../packages/babylon-lite/src/audio/audio-bus.js";
import {
    createAudioVisualizer,
    renderAudioVisualizerFrame,
    startAudioVisualizer,
    stopAudioVisualizer,
    disposeAudioVisualizer,
} from "../../../../packages/babylon-lite/src/audio/visualizer.js";

async function makeEngine() {
    const ctx = new MockAudioContext();
    return createAudioEngineAsync({ audioContext: ctx as unknown as BaseAudioContext });
}

const asCanvas = (c: MockCanvas) => c as unknown as HTMLCanvasElement;

describe("audio visualizer", () => {
    beforeEach(() => {
        installWebAudioMock();
    });
    afterEach(() => {
        uninstallWebAudioMock();
    });

    it("enables the analyzer and sizes buffers to the fftSize", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();

        const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64 });

        expect(bus._graph._analyzer).not.toBeNull();
        expect(viz._freq.length).toBe(32);
        expect(viz._time.length).toBe(64);
        disposeAudioEngine(engine);
    });

    it("throws when a 2D context is unavailable", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const badCanvas = { getContext: () => null } as unknown as HTMLCanvasElement;
        expect(() => createAudioVisualizer(bus, badCanvas)).toThrow(/2D context/);
        disposeAudioEngine(engine);
    });

    it("draws background, bars, and waveform in 'both' mode", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();
        const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64, mode: "both" });

        renderAudioVisualizerFrame(viz);

        const ctx = canvas.context2d;
        // 1 background fillRect + 32 frequency bars.
        expect(ctx.fillRectCount).toBe(1 + 32);
        // Waveform: one stroked polyline over 64 samples.
        expect(ctx.strokeCount).toBe(1);
        expect(ctx.moveToCount).toBe(1);
        expect(ctx.lineToCount).toBe(63);
        disposeAudioEngine(engine);
    });

    it("draws only the waveform in 'waveform' mode", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();
        const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64, mode: "waveform" });

        renderAudioVisualizerFrame(viz);

        const ctx = canvas.context2d;
        expect(ctx.fillRectCount).toBe(1); // background only
        expect(ctx.strokeCount).toBe(1);
        disposeAudioEngine(engine);
    });

    it("draws only the bars in 'bars' mode", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();
        const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64, mode: "bars" });

        renderAudioVisualizerFrame(viz);

        const ctx = canvas.context2d;
        expect(ctx.fillRectCount).toBe(1 + 32);
        expect(ctx.strokeCount).toBe(0);
        disposeAudioEngine(engine);
    });

    it("applies custom colors", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();
        const viz = createAudioVisualizer(bus, asCanvas(canvas), {
            fftSize: 64,
            barColor: "#ff0000",
            waveformColor: "#00ff00",
            backgroundColor: "#0000ff",
        });

        renderAudioVisualizerFrame(viz);

        const ctx = canvas.context2d;
        // The bars are the last fill drawn.
        expect(ctx.lastFillStyle).toBe("#ff0000");
        expect(ctx.strokeStyle).toBe("#00ff00");
        disposeAudioEngine(engine);
    });

    it("runs and stops the animation loop", async () => {
        let rafCb: FrameRequestCallback | null = null;
        let rafId = 0;
        let cancelled: number | null = null;
        const g = globalThis as unknown as Record<string, unknown>;
        const savedRaf = g.requestAnimationFrame;
        const savedCancel = g.cancelAnimationFrame;
        g.requestAnimationFrame = (cb: FrameRequestCallback) => {
            rafCb = cb;
            return ++rafId;
        };
        g.cancelAnimationFrame = (id: number) => {
            cancelled = id;
        };

        try {
            const engine = await makeEngine();
            const bus = await createAudioBusAsync(engine, "viz");
            const canvas = new MockCanvas();
            const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64 });

            startAudioVisualizer(viz);
            expect(viz._raf).not.toBeNull();
            // Starting again is a no-op.
            const idBefore = viz._raf;
            startAudioVisualizer(viz);
            expect(viz._raf).toBe(idBefore);

            // Drive one frame.
            expect(rafCb).not.toBeNull();
            rafCb!(0);
            expect(canvas.context2d.fillRectCount).toBeGreaterThan(0);

            stopAudioVisualizer(viz);
            expect(viz._raf).toBeNull();
            expect(cancelled).not.toBeNull();
            disposeAudioEngine(engine);
        } finally {
            g.requestAnimationFrame = savedRaf;
            g.cancelAnimationFrame = savedCancel;
        }
    });

    it("disposeAudioVisualizer stops the loop", async () => {
        const engine = await makeEngine();
        const bus = await createAudioBusAsync(engine, "viz");
        const canvas = new MockCanvas();
        const viz = createAudioVisualizer(bus, asCanvas(canvas), { fftSize: 64 });
        // No requestAnimationFrame in this environment → start is a no-op.
        startAudioVisualizer(viz);
        expect(viz._raf).toBeNull();
        disposeAudioVisualizer(viz);
        expect(viz._raf).toBeNull();
        disposeAudioEngine(engine);
    });
});
