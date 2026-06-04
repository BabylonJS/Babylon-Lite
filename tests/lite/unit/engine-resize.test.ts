import { describe, expect, it } from "vitest";

import { resizeEngine, type EngineContext, type RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";

function setDevicePixelRatio(value: number): void {
    Object.defineProperty(globalThis, "devicePixelRatio", {
        value,
        configurable: true,
    });
}

function makeEngine(canvas: Partial<HTMLCanvasElement>, contexts: RenderingContext[] = []): EngineContext {
    return {
        canvas: canvas as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        maxDevicePixelRatio: Infinity,
        _device: {} as GPUDevice,
        _context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: contexts,
        _currentEncoder: {} as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 0,
        _cbs: [],
    } as EngineContext;
}

function makeRenderingContext(onResize: () => void): RenderingContext {
    return {
        _drawCallsPre: 0,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        _update(): void {
            return;
        },
        _record(): number {
            return 0;
        },
        _resize: onResize,
    };
}

describe("resizeEngine", () => {
    it("preserves explicit canvas size when client size is zero", () => {
        setDevicePixelRatio(2);
        const canvas = { width: 640, height: 480, clientWidth: 0, clientHeight: 0 };
        let resizeCalls = 0;
        const engine = makeEngine(canvas, [makeRenderingContext(() => resizeCalls++)]);

        resizeEngine(engine);

        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
        expect(resizeCalls).toBe(0);
    });

    it("preserves explicit canvas size when client size is unavailable", () => {
        setDevicePixelRatio(2);
        const canvas = { width: 320, height: 240 };
        let resizeCalls = 0;
        const engine = makeEngine(canvas, [makeRenderingContext(() => resizeCalls++)]);

        resizeEngine(engine);

        expect(canvas.width).toBe(320);
        expect(canvas.height).toBe(240);
        expect(resizeCalls).toBe(0);
    });

    it("uses positive client size and notifies contexts only on changes", () => {
        setDevicePixelRatio(2);
        const canvas = { width: 640, height: 480, clientWidth: 400, clientHeight: 300 };
        let resizeCalls = 0;
        const engine = makeEngine(canvas, [makeRenderingContext(() => resizeCalls++)]);

        resizeEngine(engine);
        resizeEngine(engine);

        expect(canvas.width).toBe(800);
        expect(canvas.height).toBe(600);
        expect(resizeCalls).toBe(1);
    });

    it("clamps the backing store to maxDevicePixelRatio", () => {
        setDevicePixelRatio(3);
        const canvas = { width: 0, height: 0, clientWidth: 400, clientHeight: 300 };
        const engine = makeEngine(canvas) as EngineContext;
        engine.maxDevicePixelRatio = 1;

        resizeEngine(engine);

        expect(canvas.width).toBe(400);
        expect(canvas.height).toBe(300);
    });
});
