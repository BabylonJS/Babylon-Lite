import { describe, expect, it, vi } from "vitest";

import { renderFrame, type EngineContext, type RenderingContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeSurface, type SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";

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
            _context: { getCurrentTexture: vi.fn(() => texture), unconfigure: vi.fn() } as unknown as GPUCanvasContext,
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

    it("renders a cached singleton tuple", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux-a", "aux-b"]);
        const target: readonly [SurfaceContext] = [surfaces[1]!];

        renderFrame(engine, 8, target);

        expect(probe.events).toEqual(["aux-a:pre", "aux-a:update", "aux-a:record", "aux-a:capture"]);
        expect(engine.drawCallCount).toBe(3);
        expectOneSubmission(probe);
    });

    it("renders a readonly subset in caller order through one submission", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux-a", "aux-b"]);
        const subset: readonly [SurfaceContext, SurfaceContext] = [surfaces[2]!, surfaces[0]!];

        renderFrame(engine, 4, subset);

        expect(probe.events).toEqual(["aux-b:pre", "aux-b:update", "aux-b:record", "primary:pre", "primary:update", "primary:record", "aux-b:capture", "primary:capture"]);
        expect(engine.drawCallCount).toBe(6);
        expectOneSubmission(probe);
    });

    it("clears the active encoder when a selected surface fails without submitting partial work", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux"]);
        const failure = new Error("selected surface failed");
        engine.drawCallCount = 7;
        vi.mocked(surfaces[1]!._renderingContexts[0]!._record).mockImplementation(() => {
            expect(engine._currentEncoder).toBeDefined();
            throw failure;
        });

        expect(() => renderFrame(engine, 8, [surfaces[1]!])).toThrow(failure);

        expect(engine._currentEncoder).toBeUndefined();
        expect(engine.drawCallCount).toBe(7);
        expect(probe.finish).not.toHaveBeenCalled();
        expect(probe.submit).not.toHaveBeenCalled();
        expect(probe.events).toEqual(["aux:pre", "aux:update"]);
    });

    it("stops at the live engine surface count when an update disposes a later surface", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux"]);
        const aux = surfaces[1]!;
        vi.mocked(surfaces[0]!._renderingContexts[0]!._update).mockImplementation(() => {
            probe.events.push("primary:update");
            disposeSurface(aux);
        });

        renderFrame(engine, 16);

        expect(probe.events).toEqual(["primary:pre", "primary:update", "primary:record", "primary:capture"]);
        expect(engine.surfaces).toEqual([engine]);
        expect(engine.drawCallCount).toBe(3);
        expectOneSubmission(probe);
    });

    it("publishes the new draw count only after rendering callbacks complete", () => {
        const { engine, surfaces } = makeEngine(["primary"]);
        engine.drawCallCount = 7;
        let observedDrawCallCount = -1;
        vi.mocked(surfaces[0]!._renderingContexts[0]!._update).mockImplementation(() => {
            observedDrawCallCount = engine.drawCallCount;
        });

        renderFrame(engine, 16);

        expect(observedDrawCallCount).toBe(7);
        expect(engine.drawCallCount).toBe(3);
    });

    it("reports zero draw calls without submitting when the selected surface has no rendering contexts", () => {
        const { engine, surfaces, probe } = makeEngine(["primary", "aux"]);
        const flushRetirements = vi.fn();
        engine._flushGpuRetirements = flushRetirements;

        renderFrame(engine, 16, [surfaces[0]!]);
        expect(engine.drawCallCount).toBe(3);
        expect(flushRetirements).toHaveBeenCalledExactlyOnceWith(engine);

        surfaces[1]!._renderingContexts.length = 0;
        probe.events.length = 0;
        probe.createCommandEncoder.mockClear();
        probe.finish.mockClear();
        probe.submit.mockClear();
        flushRetirements.mockClear();

        renderFrame(engine, 16, [surfaces[1]!]);

        expect(engine.drawCallCount).toBe(0);
        expect(probe.events).toEqual([]);
        expect(probe.createCommandEncoder).not.toHaveBeenCalled();
        expect(probe.finish).not.toHaveBeenCalled();
        expect(probe.submit).not.toHaveBeenCalled();
        expect(flushRetirements).toHaveBeenCalledExactlyOnceWith(engine);
    });

    it("rejects a surface belonging to another engine before creating an encoder", () => {
        const { engine, probe } = makeEngine(["primary"]);
        const { surfaces: foreignSurfaces } = makeEngine(["foreign"]);
        engine.drawCallCount = 7;

        expect(() => renderFrame(engine, 16, [foreignSurfaces[0]!])).toThrow(/belongs to a different engine/);
        expect(engine.drawCallCount).toBe(7);
        expect(probe.events).toEqual([]);
        expect(probe.createCommandEncoder).not.toHaveBeenCalled();
        expect(probe.submit).not.toHaveBeenCalled();
    });
});
