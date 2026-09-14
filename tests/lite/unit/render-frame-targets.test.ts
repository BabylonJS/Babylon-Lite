import { describe, expect, it, vi } from "vitest";

import { renderFrame, type EngineContext, type RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";

interface RenderProbe {
    readonly events: string[];
    readonly createCommandEncoder: ReturnType<typeof vi.fn>;
    readonly finish: ReturnType<typeof vi.fn>;
    readonly submit: ReturnType<typeof vi.fn>;
}

function makeEngine(surfaceNames: readonly string[]): { engine: EngineContext; surfaces: SurfaceContext[]; probe: RenderProbe } {
    const events: string[] = [];
    const commandBuffer = {} as GPUCommandBuffer;
    const finish = vi.fn(() => commandBuffer);
    const encoder = { finish } as unknown as GPUCommandEncoder;
    const createCommandEncoder = vi.fn(() => encoder);
    const submit = vi.fn();
    const engine = {} as EngineContext;

    function makeSurface(name: string): SurfaceContext {
        const texture = {
            width: 16,
            height: 9,
            createView: vi.fn(() => ({ name }) as unknown as GPUTextureView),
        } as unknown as GPUTexture;
        const renderingContext: RenderingContext = {
            _kind: "test",
            _drawCallsPre: 1,
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
            _update: vi.fn(() => events.push(`${name}:update`)),
            _record: vi.fn(() => {
                events.push(`${name}:record`);
                return 2;
            }),
        };
        return {
            engine,
            canvas: { width: 16, height: 9 } as HTMLCanvasElement,
            format: "bgra8unorm",
            msaaSamples: 1,
            maxDevicePixelRatio: 1,
            _uniqueId: 1,
            _context: { getCurrentTexture: vi.fn(() => texture) } as unknown as GPUCanvasContext,
            _configureFormat: "bgra8unorm",
            _alphaMode: "opaque",
            _renderingContexts: [renderingContext],
            scRT: {
                _colorTexture: null,
                _colorView: null,
                _depthTexture: null,
                _depthView: null,
                _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 16, height: 9 } },
                _width: 16,
                _height: 9,
                _eager: true,
            } as unknown as RenderTarget,
            _capturePreFrame: vi.fn(() => events.push(`${name}:pre`)),
            _captureService: vi.fn(() => events.push(`${name}:capture`)),
        };
    }

    const surfaces = surfaceNames.map(makeSurface);
    Object.assign(engine, surfaces[0], {
        engine,
        surfaces,
        _surfaces: surfaces,
        drawCallCount: 0,
        gpuFrameTimeMs: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: {
            createCommandEncoder,
            queue: { submit },
        },
        _animFrameId: 0,
        _renderFn: null,
        _currentEncoder: {} as GPUCommandEncoder,
        _currentDelta: 0,
        _cbs: [],
    });
    surfaces[0] = engine;
    return { engine, surfaces, probe: { events, createCommandEncoder, finish, submit } };
}

function expectOneSubmission(probe: RenderProbe): void {
    expect(probe.createCommandEncoder).toHaveBeenCalledOnce();
    expect(probe.finish).toHaveBeenCalledOnce();
    expect(probe.submit).toHaveBeenCalledOnce();
}

describe("renderFrame targets", () => {
    it("renders every registered surface when no target is supplied", () => {
        const { engine, probe } = makeEngine(["primary", "aux-a", "aux-b"]);

        renderFrame(engine, 16);

        expect(probe.events).toEqual([
            "primary:pre",
            "primary:update",
            "primary:record",
            "aux-a:pre",
            "aux-a:update",
            "aux-a:record",
            "aux-b:pre",
            "aux-b:update",
            "aux-b:record",
            "primary:capture",
            "aux-a:capture",
            "aux-b:capture",
        ]);
        expect(engine.drawCallCount).toBe(9);
        expectOneSubmission(probe);
    });

    it("renders one surface without requiring an array", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux-a", "aux-b"]);

        renderFrame(engine, 8, surfaces[1]);

        expect(probe.events).toEqual(["aux-a:pre", "aux-a:update", "aux-a:record", "aux-a:capture"]);
        expect(engine.drawCallCount).toBe(3);
        expectOneSubmission(probe);
    });

    it("renders a readonly subset in caller order through one submission", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux-a", "aux-b"]);
        const subset: readonly SurfaceContext[] = [surfaces[2]!, surfaces[0]!];

        renderFrame(engine, 4, subset);

        expect(probe.events).toEqual(["aux-b:pre", "aux-b:update", "aux-b:record", "primary:pre", "primary:update", "primary:record", "aux-b:capture", "primary:capture"]);
        expect(engine.drawCallCount).toBe(6);
        expectOneSubmission(probe);
    });

    it("rejects an invalid target before creating an encoder", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux"]);
        const { surfaces: foreignSurfaces } = makeEngine(["foreign"]);
        const detachedSurface = { ...surfaces[1]!, engine };

        expect(() => renderFrame(engine, 16, [surfaces[1]!, foreignSurfaces[0]!])).toThrow(/not registered on this engine/);
        expect(() => renderFrame(engine, 16, detachedSurface)).toThrow(/not registered on this engine/);
        expect(probe.events).toEqual([]);
        expect(probe.createCommandEncoder).not.toHaveBeenCalled();
        expect(probe.submit).not.toHaveBeenCalled();
    });

    it("renders duplicate targets once at their first position", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux"]);

        renderFrame(engine, 16, [surfaces[1]!, surfaces[0]!, surfaces[1]!, surfaces[0]!]);

        expect(probe.events).toEqual(["aux:pre", "aux:update", "aux:record", "primary:pre", "primary:update", "primary:record", "aux:capture", "primary:capture"]);
        expect(engine.drawCallCount).toBe(6);
        expectOneSubmission(probe);
    });

    it("treats an empty target collection as a no-op", () => {
        const { engine, probe } = makeEngine(["primary", "aux"]);
        engine.drawCallCount = 12;

        renderFrame(engine, 16, []);

        expect(probe.events).toEqual([]);
        expect(probe.createCommandEncoder).not.toHaveBeenCalled();
        expect(probe.submit).not.toHaveBeenCalled();
        expect(engine.drawCallCount).toBe(12);
    });
});
