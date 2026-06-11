import { describe, expect, it } from "vitest";

import { type EngineContext, type RenderingContext, registerRenderingContext, unregisterRenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createSurface, disposeSurface, setSurfaceSize } from "../../../packages/babylon-lite/src/engine/surface";

function setDevicePixelRatio(value: number): void {
    Object.defineProperty(globalThis, "devicePixelRatio", { value, configurable: true });
}

// Stub the bits of `navigator.gpu` that `_buildSurface` reads when no `format`
// is supplied. Tests that pass an explicit `format` option don't need this, but
// it keeps the default-format path exercisable in the test environment.
const gpuGlobals = globalThis as Omit<typeof globalThis, "navigator"> & { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } };
gpuGlobals.navigator ??= {};
gpuGlobals.navigator.gpu ??= { getPreferredCanvasFormat: () => "bgra8unorm" };

function makeMockGpuContext(): GPUCanvasContext {
    let nextTexId = 1;
    return {
        configure: () => undefined,
        unconfigure: () => undefined,
        getCurrentTexture: () => {
            const id = nextTexId++;
            return {
                width: 16,
                height: 16,
                createView: () => ({ _kind: "view", id }) as unknown as GPUTextureView,
            } as unknown as GPUTexture;
        },
    } as unknown as GPUCanvasContext;
}

function makeMockCanvas(initial?: { clientWidth?: number; clientHeight?: number }): HTMLCanvasElement {
    const ctx = makeMockGpuContext();
    return {
        width: 0,
        height: 0,
        clientWidth: initial?.clientWidth ?? 0,
        clientHeight: initial?.clientHeight ?? 0,
        getContext: (kind: string) => (kind === "webgpu" ? ctx : null),
    } as unknown as HTMLCanvasElement;
}

function makeMockEngine(): EngineContext {
    const device = {
        createTexture: () => ({ createView: () => ({}), destroy: () => undefined }) as unknown as GPUTexture,
        destroy: () => undefined,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;

    const primaryCanvas = makeMockCanvas();
    const primaryCtx = primaryCanvas.getContext("webgpu") as unknown as GPUCanvasContext;

    const eng = {
        canvas: primaryCanvas,
        msaaSamples: 4,
        drawCallCount: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        maxDevicePixelRatio: Infinity,
        _device: device,
        _context: primaryCtx,
        format: "bgra8unorm" as GPUTextureFormat,
        _alphaMode: "opaque" as GPUCanvasAlphaMode,
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as GPUCommandEncoder,
        scRT: {
            _colorView: null,
            _colorTexture: null,
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 0, height: 0 } },
            _width: 0,
            _height: 0,
            _eager: true,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    // `surfaces` and `_surfaces` must reference the same array, just like the real
    // `createEngine` does — so push/splice through `_surfaces` are visible via the
    // public `surfaces` view.
    const _surfaces = [eng];
    Object.assign(eng, { engine: eng, surfaces: _surfaces, _surfaces });
    return eng;
}

function makeRenderingContext(onResize?: () => void): RenderingContext {
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

describe("createSurface / disposeSurface", () => {
    it("appends an auxiliary surface and shares the engine's device", () => {
        const engine = makeMockEngine();
        const auxCanvas = makeMockCanvas({ clientWidth: 200, clientHeight: 100 });
        setDevicePixelRatio(1);

        const aux = createSurface(engine, auxCanvas);

        expect(engine.surfaces.length).toBe(2);
        expect(engine.surfaces[0]).toBe(engine);
        expect(engine.surfaces[1]).toBe(aux);
        expect(aux.engine).toBe(engine);
        expect(aux.canvas).toBe(auxCanvas);
        expect(aux.format).toBe(engine.format);
        // Default MSAA matches the engine default (4x).
        expect(aux.msaaSamples).toBe(4);
        // resizeSurface populated the canvas backing store from clientWidth*DPR.
        expect(auxCanvas.width).toBe(200);
        expect(auxCanvas.height).toBe(100);
        // _refreshScRT ran once after creation — swap texture wired in.
        expect(aux.scRT._colorView).not.toBeNull();
        expect(aux.scRT._width).toBe(16);
        expect(aux.scRT._height).toBe(16);
    });

    it("honors per-surface options independently", () => {
        const engine = makeMockEngine();
        const auxCanvas = makeMockCanvas();

        const aux = createSurface(engine, auxCanvas, { msaaSamples: 1, format: "rgba8unorm" });

        expect(aux.msaaSamples).toBe(1);
        expect(aux.format).toBe("rgba8unorm");
        // Engine's primary surface is untouched by the aux surface's options.
        expect(engine.msaaSamples).toBe(4);
        expect(engine.format).toBe("bgra8unorm");
    });

    it("supports multiple auxiliary surfaces", () => {
        const engine = makeMockEngine();
        const a = createSurface(engine, makeMockCanvas());
        const b = createSurface(engine, makeMockCanvas());

        expect(engine.surfaces).toEqual([engine, a, b]);
    });

    it("isolates registered rendering contexts per surface", () => {
        const engine = makeMockEngine();
        const aux = createSurface(engine, makeMockCanvas());

        const primaryCtx = makeRenderingContext();
        const auxCtx = makeRenderingContext();
        registerRenderingContext(engine, primaryCtx);
        registerRenderingContext(aux, auxCtx);

        expect(engine._renderingContexts).toEqual([primaryCtx]);
        expect(aux._renderingContexts).toEqual([auxCtx]);

        // Unregistering on the wrong surface is a no-op.
        expect(unregisterRenderingContext(engine, auxCtx)).toBe(false);
        expect(unregisterRenderingContext(aux, primaryCtx)).toBe(false);
        expect(engine._renderingContexts).toEqual([primaryCtx]);
        expect(aux._renderingContexts).toEqual([auxCtx]);
    });

    it("setSurfaceSize only resizes contexts on the targeted surface", () => {
        const engine = makeMockEngine();
        const aux = createSurface(engine, makeMockCanvas());

        let primaryResizes = 0;
        let auxResizes = 0;
        registerRenderingContext(
            engine,
            makeRenderingContext(() => primaryResizes++)
        );
        registerRenderingContext(
            aux,
            makeRenderingContext(() => auxResizes++)
        );

        setSurfaceSize(aux, 320, 240);

        expect(primaryResizes).toBe(0);
        expect(auxResizes).toBe(1);
        expect(aux.canvas.width).toBe(320);
        expect(aux.canvas.height).toBe(240);
        // The surface-owned swapchain target tracks the canvas backing-store size so
        // canvas-sized reads at frame-graph build time see the new dimensions.
        expect(aux.scRT._width).toBe(320);
        expect(aux.scRT._height).toBe(240);
    });

    it("removes the surface from engine.surfaces on dispose and unconfigures the context", () => {
        const engine = makeMockEngine();
        const aux = createSurface(engine, makeMockCanvas());
        registerRenderingContext(aux, makeRenderingContext());

        let unconfigured = 0;
        (aux._context as { unconfigure: () => void }).unconfigure = () => unconfigured++;

        disposeSurface(aux);

        expect(engine.surfaces).toEqual([engine]);
        expect(aux._renderingContexts).toEqual([]);
        expect(unconfigured).toBe(1);
    });

    it("refuses to dispose the engine's primary surface", () => {
        const engine = makeMockEngine();

        expect(() => disposeSurface(engine)).toThrow(/primary surface/);
        // List still contains the engine itself.
        expect(engine.surfaces).toEqual([engine]);
    });
});
