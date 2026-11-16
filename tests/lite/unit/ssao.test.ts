import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";

const gpuCalls = vi.hoisted(() => ({
    create: vi.fn(),
    bind: vi.fn(),
    write: vi.fn(),
    execute: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
}));
vi.mock("../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js", () => ({
    createSsaoGpu: gpuCalls.create,
    bindSsaoGpuSources: gpuCalls.bind,
    writeSsaoGpuParameters: gpuCalls.write,
    executeSsaoGpu: gpuCalls.execute,
    clearSsaoGpu: gpuCalls.clear,
    disposeSsaoGpu: gpuCalls.dispose,
    validateSsaoQuality: (quality: string) => {
        if (!["low", "medium", "high", "ultra"].includes(quality)) {
            throw new Error(`Unsupported SSAO quality: ${quality}`);
        }
    },
}));
import { createSsaoTask, validateSsaoSettings } from "../../../packages/babylon-lite/src/post-process/ssao.js";

function fixture() {
    const engine = { _device: {}, _currentEncoder: {} } as EngineContext;
    const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 128, height: 96 } });
    const source = { createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
    depth._depthTexture = source;
    depth._width = 128;
    depth._height = 96;
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    camera.nearPlane = 0.1;
    camera.farPlane = 20;
    camera.fov = Math.PI / 3;
    return { engine, depth, camera, source };
}

beforeEach(() => {
    vi.clearAllMocks();
    gpuCalls.bind.mockImplementation((owner: SsaoGpu, _depth: GPUTextureView, normal: GPUTextureView | null) => {
        owner.providedNormals = normal !== null;
    });
    gpuCalls.create.mockImplementation(
        (device: GPUDevice, width: number, height: number, _kind: string, providedNormals: boolean) =>
            ({
                device,
                width,
                height,
                providedNormals,
                visibility: { createView: () => ({}), destroy: vi.fn() },
            }) as unknown as SsaoGpu
    );
});

describe("SSAO task boundary and lifecycle", () => {
    it("constructs default reconstruction without allocating GPU resources", () => {
        const f = fixture();
        const task = createSsaoTask({ depthTexture: f.depth, camera: f.camera }, f.engine);
        expect(task.temporal).toEqual({ enabled: true, historySamples: 16, resetVersion: 0 });
        expect(task._filter).toBeDefined();
        expect(gpuCalls.create).not.toHaveBeenCalled();
        task.dispose();
    });
    it.each([false, true, { enabled: false, historySamples: 8 }])("accepts explicit reconstruction configuration (%j)", (temporal) => {
        const f = fixture();
        const task = createSsaoTask({ depthTexture: f.depth, camera: f.camera, temporal }, f.engine);
        expect(task.temporal.enabled).toBe(typeof temporal === "boolean" ? temporal : temporal.enabled);
        expect(task.temporal.historySamples).toBe(typeof temporal === "boolean" ? 16 : 8);
        task.dispose();
    });
    it.each([null, "false", 0, []])("rejects invalid reconstruction configuration (%j)", (temporal) => {
        const f = fixture();
        expect(() => createSsaoTask({ depthTexture: f.depth, camera: f.camera, temporal: temporal as never }, f.engine)).toThrow("reconstruction options");
        expect(gpuCalls.create).not.toHaveBeenCalled();
    });
    it("does not silently default invalid reconstruction settings", () => {
        const f = fixture();
        expect(() => createSsaoTask({ depthTexture: f.depth, camera: f.camera, temporal: { enabled: null as never } }, f.engine)).toThrow("enabled");
        expect(() => createSsaoTask({ depthTexture: f.depth, camera: f.camera, temporal: { historySamples: null as never } }, f.engine)).toThrow("historySamples");
        expect(gpuCalls.create).not.toHaveBeenCalled();
    });
    it("switches normal sources without destroying borrowed inputs or replacing the managed output", () => {
        const f = fixture();
        const normal = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 128, height: 96 } });
        normal._colorView = {} as GPUTextureView;
        normal._colorTexture = { destroy: vi.fn() } as unknown as GPUTexture;
        normal._width = 128;
        normal._height = 96;
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, normalTexture: normal, camera: f.camera }, f.engine);
        const managed = task.outputTexture;
        task._onOutputChanged = vi.fn();
        task.execute!();
        const provided = task._gpu!;
        expect(provided.providedNormals).toBe(true);
        expect(gpuCalls.bind).toHaveBeenLastCalledWith(provided, expect.anything(), normal._colorView);
        task.normalTexture = null;
        task.execute!();
        const reconstructed = task._gpu!;
        expect(reconstructed.providedNormals).toBe(false);
        expect(reconstructed).toBe(provided);
        expect(gpuCalls.dispose).not.toHaveBeenCalled();
        expect(gpuCalls.bind).toHaveBeenLastCalledWith(reconstructed, expect.anything(), null);
        task.execute!();
        expect(gpuCalls.create).toHaveBeenCalledOnce();
        task.normalTexture = normal;
        task.execute!();
        expect(task._gpu!.providedNormals).toBe(true);
        expect(gpuCalls.dispose).not.toHaveBeenCalled();
        expect(task._onOutputChanged).toHaveBeenCalledOnce();
        expect(task.outputTexture).toBe(managed);
        const alternate = { ...normal, _colorView: {} as GPUTextureView };
        task.normalTexture = alternate;
        task.execute!();
        expect(gpuCalls.create).toHaveBeenCalledOnce();
        expect(gpuCalls.bind).toHaveBeenLastCalledWith(task._gpu, expect.anything(), alternate._colorView);
        task.dispose();
        expect(normal._colorTexture.destroy).not.toHaveBeenCalled();
        expect(f.source.destroy).not.toHaveBeenCalled();
    });
    it("validates a replacement normal attachment before selecting it", () => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        task.execute!();
        for (const normal of [
            createRenderTarget({ format: "rgba16float", samples: 4, size: { width: 128, height: 96 } }),
            createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 128, height: 96 } }),
        ]) {
            task.normalTexture = normal;
            expect(() => task.execute!()).toThrow("single-sample color attachment");
        }
        task.normalTexture = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 64, height: 96 } });
        expect(() => task.execute!()).toThrow("identical dimensions");
        task.normalTexture = null;
        expect(() => task.execute!()).not.toThrow();
        expect(gpuCalls.create).toHaveBeenCalledOnce();
    });
    it("passes normalized intensity to XeGTAO without an algorithm-specific gain", () => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera, intensity: 1 }, f.engine);
        task.execute!();
        expect(task.intensity).toBe(1);
        expect(gpuCalls.write.mock.calls.at(-1)![1].intensity).toBe(1);
        task.intensity = 0.25;
        task.execute!();
        expect(gpuCalls.write.mock.calls.at(-1)![1].intensity).toBe(0.25);
        task.intensity = 0;
        task.execute!();
        expect(gpuCalls.write.mock.calls.at(-1)![1].intensity).toBe(0);
        expect(task).not.toHaveProperty("algorithm");
        expect(task).not.toHaveProperty("thickness");
    });
    it("accepts valid XeGTAO settings", () => {
        expect(() => validateSsaoSettings(0.5, 1)).not.toThrow();
    });
    it.each([
        ["radius", 0, 1],
        ["radius", NaN, 1],
        ["radius", Infinity, 1],
        ["intensity", 0.5, -1],
        ["intensity", 0.5, 1.01],
    ] as const)("rejects invalid mutable %s without silent clamping", (name, radius, intensity) => {
        expect(() => validateSsaoSettings(radius, intensity)).toThrow(name);
    });
    it("requires a resolved depth attachment and built producer before recording", () => {
        const f = fixture();
        expect(() =>
            createSsaoTask({ temporal: false, ...f, depthTexture: createRenderTarget({ dFormat: "depth32float", samples: 4, size: { width: 128, height: 96 } }) }, f.engine)
        ).toThrow("single-sample");
        const target = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 128, height: 96 } });
        const task = createSsaoTask({ temporal: false, camera: f.camera, depthTexture: target }, f.engine);
        expect(() => task.record()).toThrow("not built");
    });
    it("reuses resources per frame for XeGTAO", () => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        task.record();
        task.execute!();
        task.execute!();
        expect(gpuCalls.create).toHaveBeenCalledTimes(1);
        expect(gpuCalls.execute).toHaveBeenLastCalledWith(task._gpu, f.engine._currentEncoder, "high");
        expect(task.outputTexture._width).toBe(128);
        expect(gpuCalls.write.mock.calls[0]![1].depthMultiply).toBeLessThan(0);
        expect(f.source.createView).toHaveBeenCalledTimes(1);
        expect(task.depthTexture).toBe(f.depth);
        expect(gpuCalls.bind.mock.calls[0]![1]).toBe(vi.mocked(f.source.createView).mock.results[0]!.value);
        task.dispose();
        expect(f.source.destroy).not.toHaveBeenCalled();
    });
    it.each(["low", "medium", "high", "ultra"] as const)("passes spatial quality %s without reallocating public output", (quality) => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera, quality }, f.engine);
        task.execute!();
        const output = task.outputTexture._colorTexture;
        expect(task.quality).toBe(quality);
        expect(gpuCalls.execute).toHaveBeenLastCalledWith(task._gpu, f.engine._currentEncoder, quality);
        expect(gpuCalls.write.mock.calls.at(-1)![1].quality).toBe(quality);
        task.quality = "ultra";
        task.execute!();
        expect(gpuCalls.create).toHaveBeenCalledOnce();
        expect(task.outputTexture._colorTexture).toBe(output);
    });
    it("rejects unsupported spatial quality instead of silently selecting a preset", () => {
        const f = fixture();
        expect(() => validateSsaoSettings(0.5, 1, "invalid" as never)).toThrow("quality");
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        Object.assign(task, { quality: "invalid" });
        expect(() => task.record()).toThrow("quality");
        expect(() => task.execute!()).toThrow("quality");
    });
    it("neutralizes a disabled output once and resumes current-frame computation", () => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        task.record();
        task.enabled = false;
        task.execute!();
        task.execute!();
        expect(gpuCalls.clear).toHaveBeenCalledTimes(1);
        expect(gpuCalls.execute).not.toHaveBeenCalled();
        task.enabled = true;
        task.execute!();
        expect(gpuCalls.execute).toHaveBeenCalledTimes(1);
    });
    it("replaces owned state on resize and disposal never destroys borrowed sources", () => {
        const f = fixture();
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        task.record();
        const first = task._gpu;
        f.depth._width = 63;
        f.depth._height = 49;
        task.record();
        expect(gpuCalls.dispose).toHaveBeenCalledWith(first);
        expect(task.outputTexture._width).toBe(63);
        task.dispose();
        task.dispose();
        expect(gpuCalls.dispose).toHaveBeenCalledTimes(2);
        expect(f.source.destroy).not.toHaveBeenCalled();
        expect(() => task.execute!()).toThrow("disposed");
    });
    it("rejects mismatched normals and unsupported camera projections explicitly", () => {
        const f = fixture();
        const normal = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 128, height: 96 } });
        expect(() => createSsaoTask({ temporal: false, depthTexture: f.depth, normalTexture: normal, camera: f.camera }, f.engine).record()).toThrow("identical dimensions");
        const task = createSsaoTask({ temporal: false, depthTexture: f.depth, camera: f.camera }, f.engine);
        task.record();
        f.camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        expect(() => task.execute!()).toThrow("full-target");
        f.camera.viewport = undefined;
        f.camera.fov = NaN;
        expect(() => task.execute!()).toThrow("FOV");
    });
});
