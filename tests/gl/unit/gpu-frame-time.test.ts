import { afterEach, describe, expect, it, vi } from "vitest";
import { beginFrame, captureGPUFrameTime, createGLEngine, disposeGLEngine, endFrame, getGPUFrameTimeCounter, runRenderLoop } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockGL } from "./_lite-gl-mock";

const TIME_ELAPSED_EXT = 0x88bf;

function setup(supported = true): { mock: MockGL; engine: ReturnType<typeof createGLEngine>; canvas: ReturnType<typeof createMockCanvas> } {
    const mock = createMockGL();
    mock.setExtensionAvailable("EXT_disjoint_timer_query_webgl2", supported);
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, engine, canvas };
}

function frame(engine: ReturnType<typeof createGLEngine>): void {
    beginFrame(engine);
    endFrame(engine);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("lite-gl GPU frame time (#83)", () => {
    it("getGPUFrameTimeCounter returns a stable, zeroed counter", () => {
        const { engine } = setup();
        const counter = getGPUFrameTimeCounter(engine);
        expect(getGPUFrameTimeCounter(engine)).toBe(counter);
        expect(counter).toMatchObject({ current: 0, average: 0, lastSecAverage: 0, min: 0, max: 0, total: 0, count: 0 });
    });

    it("beginFrame / endFrame are no-ops while capture is disabled", () => {
        const { mock, engine } = setup();
        frame(engine);
        expect(mock.count("createQuery")).toBe(0);
    });

    it("does nothing when EXT_disjoint_timer_query_webgl2 is unavailable", () => {
        const { mock, engine } = setup(false);
        captureGPUFrameTime(engine, true);
        frame(engine);
        frame(engine);
        expect(mock.count("createQuery")).toBe(0);
        expect(getGPUFrameTimeCounter(engine).count).toBe(0);
    });

    it("wraps a frame in a TIME_ELAPSED query and records the result in nanoseconds", () => {
        const { mock, engine } = setup();
        mock.setTimerQuery({ result: 2_000_000 });
        captureGPUFrameTime(engine, true);
        beginFrame(engine);
        const begin = mock.log.find((c) => c.name === "beginQuery");
        expect(begin?.args[0]).toBe(TIME_ELAPSED_EXT);
        endFrame(engine);
        expect(mock.log.find((c) => c.name === "endQuery")?.args[0]).toBe(TIME_ELAPSED_EXT);
        expect(mock.count("deleteQuery")).toBe(1);
        const counter = getGPUFrameTimeCounter(engine);
        expect(counter).toMatchObject({ current: 2_000_000, average: 2_000_000, min: 2_000_000, max: 2_000_000, total: 2_000_000, count: 1 });
    });

    it("keeps one query in flight until its result is available", () => {
        const { mock, engine } = setup();
        mock.setTimerQuery({ available: false, result: 1000 });
        captureGPUFrameTime(engine, true);
        frame(engine);
        frame(engine);
        frame(engine);
        expect(mock.count("createQuery")).toBe(1);
        expect(mock.count("endQuery")).toBe(1);
        expect(getGPUFrameTimeCounter(engine).count).toBe(0);

        mock.setTimerQuery({ available: true });
        frame(engine);
        expect(getGPUFrameTimeCounter(engine).count).toBe(1);
        frame(engine);
        expect(mock.count("createQuery")).toBe(2);
    });

    it("accumulates min / max / average / total across samples", () => {
        const { mock, engine } = setup();
        captureGPUFrameTime(engine, true);
        for (const ns of [300, 100, 200]) {
            mock.setTimerQuery({ result: ns });
            frame(engine);
        }
        expect(getGPUFrameTimeCounter(engine)).toMatchObject({ current: 200, min: 100, max: 300, total: 600, average: 200, count: 3 });
    });

    it("lastSecAverage averages the samples of each elapsed ~1 s window", () => {
        let now = 5000;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const { mock, engine } = setup();
        captureGPUFrameTime(engine, true);
        mock.setTimerQuery({ result: 100 });
        frame(engine);
        const counter = getGPUFrameTimeCounter(engine);
        expect(counter.lastSecAverage).toBe(100);
        for (const ns of [200, 400]) {
            now += 400;
            mock.setTimerQuery({ result: ns });
            frame(engine);
        }
        expect(counter.lastSecAverage).toBe(100);
        now += 400;
        mock.setTimerQuery({ result: 600 });
        frame(engine);
        expect(counter.lastSecAverage).toBe(400);
    });

    it("discards results that overlap a disjoint GPU event", () => {
        const { mock, engine } = setup();
        mock.setTimerQuery({ result: 500, disjoint: true });
        captureGPUFrameTime(engine, true);
        frame(engine);
        expect(getGPUFrameTimeCounter(engine).count).toBe(0);
        expect(mock.count("deleteQuery")).toBe(1);

        mock.setTimerQuery({ disjoint: false });
        frame(engine);
        expect(getGPUFrameTimeCounter(engine).count).toBe(1);
    });

    it("disabling releases the pending query and stops measuring; the counter is kept", () => {
        const { mock, engine } = setup();
        mock.setTimerQuery({ result: 10 });
        captureGPUFrameTime(engine, true);
        frame(engine);
        mock.setTimerQuery({ available: false });
        beginFrame(engine);
        captureGPUFrameTime(engine, false);
        expect(mock.count("endQuery")).toBe(2);
        expect(mock.count("deleteQuery")).toBe(2);
        expect(engine._onLost).toHaveLength(0);

        mock.clear();
        frame(engine);
        expect(mock.count("createQuery")).toBe(0);

        const counter = getGPUFrameTimeCounter(engine);
        captureGPUFrameTime(engine, true);
        expect(getGPUFrameTimeCounter(engine)).toBe(counter);
        expect(counter.count).toBe(1);
    });

    it("enabling twice is idempotent", () => {
        const { engine } = setup();
        captureGPUFrameTime(engine, true);
        const hooks = engine._frameHooks;
        captureGPUFrameTime(engine, true);
        expect(engine._frameHooks).toBe(hooks);
        expect(engine._onLost).toHaveLength(1);
    });

    it("drops the in-flight query on context loss and resumes after restore", () => {
        const { mock, engine, canvas } = setup();
        mock.setTimerQuery({ available: false });
        captureGPUFrameTime(engine, true);
        beginFrame(engine);
        fireLost(canvas);
        mock.clear();
        frame(engine);
        expect(mock.log).toHaveLength(0);

        fireRestored(canvas);
        mock.clear();
        mock.setTimerQuery({ available: true, result: 42 });
        frame(engine);
        expect(mock.count("deleteQuery")).toBe(1);
        expect(mock.count("createQuery")).toBe(1);
        expect(getGPUFrameTimeCounter(engine).current).toBe(42);
    });

    it("disposeGLEngine releases the pending query", () => {
        const { mock, engine } = setup();
        mock.setTimerQuery({ available: false });
        captureGPUFrameTime(engine, true);
        beginFrame(engine);
        disposeGLEngine(engine);
        expect(mock.count("deleteQuery")).toBe(1);
        expect(engine._frameHooks).toBeUndefined();
        captureGPUFrameTime(engine, true);
        expect(engine._frameHooks).toBeUndefined();
    });

    it("runRenderLoop brackets its callbacks with the frame hooks", () => {
        let pending: FrameRequestCallback | null = null;
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            pending = cb;
            return 1;
        });
        vi.stubGlobal("cancelAnimationFrame", () => undefined);
        const { mock, engine } = setup();
        mock.setTimerQuery({ result: 7 });
        captureGPUFrameTime(engine, true);
        const order: string[] = [];
        runRenderLoop(engine, () => {
            order.push(`cb:${mock.count("beginQuery")}/${mock.count("endQuery")}`);
        });
        (pending as FrameRequestCallback | null)?.(16);
        expect(order).toEqual(["cb:1/0"]);
        expect(mock.count("endQuery")).toBe(1);
        expect(getGPUFrameTimeCounter(engine).current).toBe(7);
    });
});
