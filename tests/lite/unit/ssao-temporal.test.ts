import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix } from "../../../packages/babylon-lite/src/camera/camera.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import type { SsaoGpu, SsaoGpuParameters } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { enableSsaoTemporal, resetSsaoTemporal, validateSsaoTemporalSettings } from "../../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import type { DiligentTemporalGpu as SsaoTemporalGpu } from "../../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { enableSsaoMotionPruning } from "../../../packages/babylon-lite/src/post-process/ssao-motion-pruning.js";

const calls = vi.hoisted(() => ({ create: vi.fn(), bind: vi.fn(), execute: vi.fn(), dispose: vi.fn() }));
vi.mock("../../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js", () => ({
    createDiligentTemporalGpu: calls.create,
    bindDiligentTemporalGpu: calls.bind,
    executeDiligentTemporalGpu: calls.execute,
    disposeDiligentTemporalGpu: calls.dispose,
}));
beforeEach(() => {
    vi.clearAllMocks();
    calls.create.mockImplementation(
        (owner: SsaoGpu, velocity: GPUTextureView | null): SsaoTemporalGpu =>
            ({
                owner,
                data: new Float32Array(96),
                sourceDepth: owner.sourceDepth!,
                sourceNormal: owner.sourceNormal,
                velocity,
                baseResolve: owner.resolveGroup,
                scratchResolve: {} as GPUBindGroup,
            }) as SsaoTemporalGpu
    );
    calls.bind.mockImplementation((state: SsaoTemporalGpu, velocity: GPUTextureView | null) => {
        state.sourceDepth = state.owner.sourceDepth!;
        state.sourceNormal = state.owner.sourceNormal;
        state.velocity = velocity;
    });
});
function fixture() {
    const engine = { _device: {} } as EngineContext;
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 16, height: 16 } });
    const task = createSsaoTask({ camera, depthTexture: depth }, engine);
    const gpu = { width: 16, height: 16, device: engine._device, sourceDepth: {}, sourceNormal: null, resolveGroup: {} } as SsaoGpu;
    const params: SsaoGpuParameters = {
        depthMultiply: -0.1,
        depthAdd: 0,
        tanX: 1,
        tanY: 1,
        far: camera.farPlane,
        radius: task.radius,
        intensity: task.intensity,
        view: getViewMatrix(camera),
    };
    const frame = (): number => {
        params.view = getViewMatrix(camera);
        task._filter!.prepare(gpu, params);
        task._filter!.execute(gpu, {} as GPUCommandEncoder);
        return params.phase!;
    };
    const history = (): SsaoTemporalGpu => calls.create.mock.results.at(-1)!.value as SsaoTemporalGpu;
    return { engine, camera, task, gpu, params, frame, history };
}
describe("temporal SSAO API and history lifecycle", () => {
    it("requires explicit pruning opt-in after temporal filtering with velocity", () => {
        const f = fixture();
        expect(() => enableSsaoMotionPruning(f.task)).toThrow("object velocity first");
        const settings = enableSsaoTemporal(f.task);
        expect(settings._prepareGpu).toBeUndefined();
        expect(() => enableSsaoMotionPruning(f.task)).toThrow("object velocity first");
        f.task.dispose();
        expect(() => enableSsaoMotionPruning(f.task)).toThrow("disposed");
    });
    it("keeps disabled pruning allocation-free and preserves the temporal phase", () => {
        const f = fixture();
        const velocity = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 16, height: 16 } });
        velocity._colorView = {} as GPUTextureView;
        velocity._width = velocity._height = 16;
        enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
        const settings = enableSsaoMotionPruning(f.task);
        settings.enabled = false;
        expect(enableSsaoMotionPruning(f.task)).toBe(settings);
        expect(settings.enabled).toBe(false);
        expect(f.frame()).toBe(0);
        expect(f.frame()).toBe(1);
        expect(f.history().data[48]).toBe(0);
        expect(f.history().transportExtension).toBeUndefined();
        expect(calls.create).toHaveBeenCalledOnce();
        expect(calls.create).toHaveBeenCalledWith(f.gpu, velocity._colorView, true, true);
    });
    it("passes current velocity through the optional preparation seam without resetting history", () => {
        const f = fixture();
        const velocity = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 16, height: 16 } });
        velocity._colorView = {} as GPUTextureView;
        velocity._width = velocity._height = 16;
        const settings = enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
        settings._prepareGpu = vi.fn();
        f.frame();
        expect(settings._prepareGpu).toHaveBeenLastCalledWith(f.history(), velocity._colorView);
        f.gpu.sourceVelocity = {} as GPUTextureView;
        f.frame();
        expect(settings._prepareGpu).toHaveBeenLastCalledWith(f.history(), f.gpu.sourceVelocity);
        expect(f.history().data[48]).toBe(1);
        expect(f.frame()).toBe(1);
        settings.enabled = false;
        f.frame();
        expect(settings._prepareGpu).toHaveBeenCalledTimes(4);
    });
    it.each([1, 8, 32, 64])("preserves the configured upper bound %s within native history length", (historySamples) => {
        const f = fixture();
        enableSsaoTemporal(f.task, { historySamples });
        f.frame();
        expect(f.history().data[49]).toBe(Math.min(historySamples, 16));
        expect(f.history().data[50]).toBe(1);
    });
    it.each([0, 65, 1.5, NaN])("rejects an invalid sample limit %s", (historySamples) => {
        expect(() => validateSsaoTemporalSettings({ enabled: true, historySamples, resetVersion: 0 })).toThrow("historySamples");
    });
    it("rejects invalid reset versions and detects overflow", () => {
        expect(() => resetSsaoTemporal({ enabled: true, historySamples: 32, resetVersion: -1 })).toThrow("resetVersion");
        expect(() => resetSsaoTemporal({ enabled: true, historySamples: 32, resetVersion: Number.MAX_SAFE_INTEGER })).toThrow("incremented");
    });
    it("rotates phases, reuses allocations, and keeps ordinary camera motion", () => {
        const f = fixture();
        expect(enableSsaoTemporal(f.task)).toBe(enableSsaoTemporal(f.task));
        expect(f.frame()).toBe(0);
        expect(f.history().data[48]).toBe(1);
        expect(f.frame()).toBe(1);
        expect(f.history().data[48]).toBe(0);
        f.camera.position.x = 0.05;
        expect(f.frame()).toBe(2);
        expect(f.history().data[48]).toBe(0);
        expect(calls.create).toHaveBeenCalledOnce();
    });
    it("keeps spatial quality and temporal history limits independent", () => {
        const f = fixture();
        const temporal = enableSsaoTemporal(f.task, { historySamples: 8 });
        f.frame();
        f.frame();
        const owner = f.history();
        f.task.quality = "ultra";
        expect(f.frame()).toBe(0);
        expect(temporal.historySamples).toBe(8);
        expect(owner.data[49]).toBe(8);
        expect(f.frame()).toBe(1);
        temporal.historySamples = 4;
        expect(f.frame()).toBe(0);
        expect(f.task.quality).toBe("ultra");
        expect(owner.data[49]).toBe(4);
        expect(f.history()).toBe(owner);
        expect(calls.create).toHaveBeenCalledOnce();
    });
    it("restores static phase/base output on disable and restarts on re-enable", () => {
        const f = fixture(),
            settings = enableSsaoTemporal(f.task);
        f.frame();
        f.frame();
        settings.enabled = false;
        expect(f.frame()).toBe(0);
        expect(f.gpu.resolveGroup).toBe(f.history().baseResolve);
        expect(calls.execute).toHaveBeenCalledTimes(2);
        settings.enabled = true;
        expect(f.frame()).toBe(0);
        expect(f.history().data[48]).toBe(1);
    });
    it("resets on cuts, explicit resets, source replacement, and changed settings", () => {
        const f = fixture(),
            settings = enableSsaoTemporal(f.task);
        f.frame();
        f.frame();
        f.camera.position.x = 100;
        expect(f.frame()).toBe(0);
        f.frame();
        resetSsaoTemporal(settings);
        expect(f.frame()).toBe(0);
        f.frame();
        settings.historySamples = 16;
        expect(f.frame()).toBe(0);
        f.frame();
        f.task.quality = "low";
        expect(f.frame()).toBe(0);
        f.frame();
        f.task.radius = 0.75;
        expect(f.frame()).toBe(0);
        f.frame();
        f.gpu.sourceDepth = {} as GPUTextureView;
        expect(f.frame()).toBe(0);
        f.frame();
        f.task._filter!.reset();
        expect(f.frame()).toBe(0);
    });
    it("rejects velocity formats and dimension mismatch, without destroying sources", () => {
        const f = fixture();
        const invalid = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } });
        expect(() => enableSsaoTemporal(f.task, { velocityTexture: invalid })).toThrow("floating-point");
        const velocity = createRenderTarget({ format: "rg16float", samples: 1, size: { width: 16, height: 16 } });
        enableSsaoTemporal(f.task, { velocityTexture: velocity });
        expect(() => f.frame()).toThrow("identical dimensions");
        velocity._colorView = {} as GPUTextureView;
        velocity._width = velocity._height = 16;
        expect(f.frame()).toBe(0);
        const other = createRenderTarget({ format: "rg16float", samples: 1, size: { width: 16, height: 16 } });
        expect(() => enableSsaoTemporal(f.task, { velocityTexture: other })).toThrow("different velocity");
    });
    it("requires RGBA floating velocity for the previous-depth contract", () => {
        const f = fixture();
        expect(() => enableSsaoTemporal(f.task, { velocityHasPreviousDepth: true })).toThrow("floating-point RGBA");
        for (const format of ["rg16float", "rg32float"] as const) {
            const velocity = createRenderTarget({ format, samples: 1, size: { width: 16, height: 16 } });
            expect(() => enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true })).toThrow("floating-point RGBA");
        }
        for (const format of ["rgba16float", "rgba32float"] as const) {
            const other = fixture();
            const velocity = createRenderTarget({ format, samples: 1, size: { width: 16, height: 16 } });
            velocity._colorView = {} as GPUTextureView;
            velocity._width = velocity._height = 16;
            enableSsaoTemporal(other.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
            other.frame();
            const data = other.history().data;
            expect(data[51]).toBe(1);
            // Half-float velocity is compared against its own rounding, never the FP32 tolerance.
            expect(data[84]).toBe(format === "rgba16float" ? Math.fround(2 ** -10) : Math.fround(1e-5));
            expect(data[85]).toBe(format === "rgba16float" ? Math.fround(2 ** -10) : 0);
        }
    });
    it("uploads the static previous-depth reprojection rows", () => {
        const f = fixture();
        enableSsaoTemporal(f.task);
        f.frame();
        f.frame();
        const data = f.history().data;
        const inverseVP = data.subarray(52, 68),
            previousVP = data.subarray(32, 48);
        for (let column = 0; column < 4; column++) {
            let w = 0;
            for (let k = 0; k < 4; k++) w += previousVP[k * 4 + 3]! * inverseVP[column * 4 + k]!;
            expect(Math.abs(data[88 + column]! - w)).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(w)));
            expect(data[92 + column]).toBe(inverseVP[column * 4 + 3]);
        }
    });
    it("preserves the previous-depth contract on repeated enabling", () => {
        const f = fixture();
        const velocity = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 16, height: 16 } });
        const settings = enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
        expect(enableSsaoTemporal(f.task)).toBe(settings);
        expect(enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true })).toBe(settings);
        expect(() => enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: false })).toThrow("different velocity depth contract");
        const other = fixture();
        enableSsaoTemporal(other.task, { velocityTexture: velocity });
        expect(() => enableSsaoTemporal(other.task, { velocityTexture: velocity, velocityHasPreviousDepth: true })).toThrow("different velocity depth contract");
    });
    it("releases previous owners on resize/device replacement and disposes once", () => {
        const f = fixture();
        enableSsaoTemporal(f.task);
        f.frame();
        const old = f.history();
        const next = { ...f.gpu, width: 17, resolveGroup: {} } as SsaoGpu;
        f.task._filter!.prepare(next, f.params);
        expect(calls.dispose).toHaveBeenCalledWith(old);
        expect(f.params.phase).toBe(0);
        f.task.dispose();
        f.task.dispose();
        expect(calls.dispose).toHaveBeenCalledTimes(2);
        expect(() => enableSsaoTemporal(f.task)).toThrow("disposed");
    });
    it("rejects unsupported floating-origin reprojection explicitly", () => {
        const f = fixture();
        Object.assign(f.engine, { useFloatingOrigin: true });
        expect(() => enableSsaoTemporal(f.task)).toThrow("floating-origin");
    });
});
