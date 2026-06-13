import { describe, expect, it, beforeAll } from "vitest";
import { createGLEngine, runRenderLoop, stopRenderLoop } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL } from "./_lite-gl-mock";

beforeAll(() => {
    // Node has no rAF — stub it to a deterministic no-op. runRenderLoop calls
    // requestAnimationFrame to schedule the first frame; the dedupe-shape tests
    // never advance the frame, so a no-op is enough.
    const g = globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number; cancelAnimationFrame?: (h: number) => void };
    if (g.requestAnimationFrame === undefined) {
        g.requestAnimationFrame = () => 1;
    }
    if (g.cancelAnimationFrame === undefined) {
        g.cancelAnimationFrame = () => undefined;
    }
});

describe("lite-gl render loop", () => {
    it("runRenderLoop dedupes — registering the same fn twice fires it once per frame", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        const cb = () => undefined;
        runRenderLoop(engine, cb);
        runRenderLoop(engine, cb);
        runRenderLoop(engine, cb);
        expect(engine._loops.length).toBe(1);
    });

    it("stopRenderLoop() with no arg removes all loops", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        runRenderLoop(engine, () => undefined);
        runRenderLoop(engine, () => undefined);
        expect(engine._loops.length).toBe(2);
        stopRenderLoop(engine);
        expect(engine._loops.length).toBe(0);
    });

    it("stopRenderLoop(fn) only removes the matching callback", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        const a = () => undefined;
        const b = () => undefined;
        runRenderLoop(engine, a);
        runRenderLoop(engine, b);
        stopRenderLoop(engine, a);
        expect(engine._loops.length).toBe(1);
        expect(engine._loops[0]).toBe(b);
    });
});
