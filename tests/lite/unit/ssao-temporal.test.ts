import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix } from "../../../packages/babylon-lite/src/camera/camera.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import type { SsaoTaskConfig } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import type { SsaoGpu, SsaoGpuParameters } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";
import { getSsaoTemporalEntry, resetSsaoTemporal, validateSsaoTemporalSettings } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-temporal.js";
import type { XegtaoTemporalGpu as SsaoTemporalGpu } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js";
import { enableSsaoMotionPruning } from "../../../packages/babylon-lite/src/post-process/ssao/ssao-motion-pruning.js";

const calls = vi.hoisted(() => ({ create: vi.fn(), bind: vi.fn(), execute: vi.fn(), dispose: vi.fn() }));
vi.mock("../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js", () => ({
    createXegtaoTemporalGpu: calls.create,
    bindXegtaoTemporalGpu: calls.bind,
    executeXegtaoTemporalGpu: calls.execute,
    disposeXegtaoTemporalGpu: calls.dispose,
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
function velocityTarget(format: GPUTextureFormat = "rgba32float", built = true) {
    const velocity = createRenderTarget({ format, samples: 1, size: { width: 16, height: 16 } });
    if (built) {
        velocity._colorView = {} as GPUTextureView;
        velocity._width = velocity._height = 16;
    }
    return velocity;
}
function fixture(temporal?: SsaoTaskConfig["temporal"], floatingOrigin = false) {
    const engine = { _device: {}, useFloatingOrigin: floatingOrigin } as EngineContext;
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 16, height: 16 } });
    const task = createSsaoTask({ camera, depthTexture: depth, temporal }, engine);
    const gpu = { width: 16, height: 16, device: engine._device, sourceDepth: {}, sourceNormal: null, resolveGroup: {} } as SsaoGpu;
    const params: SsaoGpuParameters = {
        depthMultiply: -0.1,
        depthAdd: 0,
        tanX: 1,
        tanY: 1,
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
describe("default SSAO reconstruction and history lifecycle", () => {
    it("creates the complete pipeline without a separate enabler and allocates history lazily", () => {
        const f = fixture();
        expect(f.task.temporal).toEqual({ enabled: true, historySamples: 16, resetVersion: 0 });
        expect(getSsaoTemporalEntry(f.task)!.settings).toBe(f.task.temporal);
        expect(calls.create).not.toHaveBeenCalled();
        expect(f.frame()).toBe(0);
        expect(f.frame()).toBe(1);
        expect(calls.create).toHaveBeenCalledOnce();
        expect(calls.execute).toHaveBeenCalledTimes(2);
    });
    it.each([false, { enabled: false }])("keeps explicit spatial-only construction history-free (%j)", (temporal) => {
        const f = fixture(temporal);
        const settings = f.task.temporal;
        expect(settings.enabled).toBe(false);
        expect(f.frame()).toBe(0);
        expect(f.frame()).toBe(0);
        expect(calls.create).not.toHaveBeenCalled();
        expect(calls.execute).not.toHaveBeenCalled();
        settings.enabled = true;
        expect(f.frame()).toBe(0);
        expect(f.task.temporal).toBe(settings);
        expect(calls.create).toHaveBeenCalledOnce();
    });
    it("configures object velocity while starting reconstruction disabled", () => {
        const velocity = velocityTarget();
        const f = fixture({ enabled: false, velocityTexture: velocity, velocityHasPreviousDepth: true, historySamples: 8 });
        f.frame();
        expect(calls.create).not.toHaveBeenCalled();
        f.task.temporal.enabled = true;
        f.frame();
        expect(calls.create).toHaveBeenCalledWith(f.gpu, velocity._colorView, true, true);
        expect(f.history().data[49]).toBe(8);
    });
    it("requires object velocity for the separate pruning opt-in", () => {
        const f = fixture();
        expect(f.task.temporal._prepareGpu).toBeUndefined();
        expect(() => enableSsaoMotionPruning(f.task)).toThrow("object velocity texture");
        f.task.dispose();
        expect(() => enableSsaoMotionPruning(f.task)).toThrow("disposed");
    });
    it("keeps disabled pruning allocation-free and preserves the temporal phase", () => {
        const velocity = velocityTarget();
        const f = fixture({ velocityTexture: velocity, velocityHasPreviousDepth: true });
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
        const velocity = velocityTarget();
        const f = fixture({ velocityTexture: velocity, velocityHasPreviousDepth: true });
        const settings = f.task.temporal;
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
    it.each([1, 8, 16])("uploads the configured native history limit %s", (historySamples) => {
        const f = fixture({ historySamples });
        f.frame();
        expect(f.history().data[49]).toBe(historySamples);
    });
    it.each([0, 17, 1.5, NaN])("rejects an invalid constructor sample limit %s", (historySamples) => {
        expect(() => fixture({ historySamples })).toThrow("historySamples");
        expect(calls.create).not.toHaveBeenCalled();
    });
    it("validates mutable reconstruction settings and reset overflow", () => {
        expect(() => validateSsaoTemporalSettings({ enabled: 1 as never, historySamples: 16, resetVersion: 0 })).toThrow("enabled");
        expect(() => validateSsaoTemporalSettings({ enabled: true, historySamples: 0, resetVersion: 0 })).toThrow("historySamples");
        expect(() => validateSsaoTemporalSettings({ enabled: true, historySamples: 17, resetVersion: 0 })).toThrow("[1, 16]");
        expect(() => resetSsaoTemporal({ enabled: true, historySamples: 16, resetVersion: -1 })).toThrow("resetVersion");
        expect(() => resetSsaoTemporal({ enabled: true, historySamples: 16, resetVersion: Number.MAX_SAFE_INTEGER })).toThrow("incremented");
    });
    it("rotates phases, reuses allocations, and keeps ordinary camera motion", () => {
        const f = fixture();
        const settings = f.task.temporal;
        expect(f.frame()).toBe(0);
        expect(f.history().data[48]).toBe(1);
        expect(f.frame()).toBe(1);
        expect(f.history().data[48]).toBe(0);
        f.camera.position.x = 0.05;
        expect(f.frame()).toBe(2);
        expect(f.history().data[48]).toBe(0);
        expect(f.task.temporal).toBe(settings);
        expect(calls.create).toHaveBeenCalledOnce();
    });
    it("keeps spatial quality and temporal history limits independent", () => {
        const f = fixture({ historySamples: 8 });
        const temporal = f.task.temporal;
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
        const f = fixture();
        f.frame();
        f.frame();
        f.task.temporal.enabled = false;
        expect(f.frame()).toBe(0);
        expect(f.gpu.resolveGroup).toBe(f.history().baseResolve);
        expect(calls.execute).toHaveBeenCalledTimes(2);
        f.task.temporal.enabled = true;
        expect(f.frame()).toBe(0);
        expect(f.history().data[48]).toBe(1);
    });
    it("resets on cuts, explicit resets, source replacement, and changed settings", () => {
        const f = fixture();
        const settings = f.task.temporal;
        f.frame();
        f.frame();
        f.camera.position.x = 100;
        expect(f.frame()).toBe(0);
        f.frame();
        resetSsaoTemporal(settings);
        expect(f.frame()).toBe(0);
        f.frame();
        settings.historySamples = 8;
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
    it("rejects invalid velocity formats before GPU work and unbuilt dimensions at execution", () => {
        expect(() => fixture({ velocityTexture: velocityTarget("rgba8unorm") })).toThrow("floating-point");
        const velocity = velocityTarget("rg16float", false);
        const f = fixture({ velocityTexture: velocity });
        expect(() => f.frame()).toThrow("identical dimensions");
        expect(calls.create).not.toHaveBeenCalled();
        velocity._colorView = {} as GPUTextureView;
        velocity._width = velocity._height = 16;
        expect(f.frame()).toBe(0);
        expect(getSsaoTemporalEntry(f.task)!.velocity).toBe(velocity);
    });
    it("requires RGBA floating velocity for the previous-depth contract", () => {
        expect(() => fixture({ velocityHasPreviousDepth: true })).toThrow("floating-point RGBA");
        for (const format of ["rg16float", "rg32float"] as const) {
            expect(() => fixture({ velocityTexture: velocityTarget(format), velocityHasPreviousDepth: true })).toThrow("floating-point RGBA");
        }
        for (const format of ["rgba16float", "rgba32float"] as const) {
            const f = fixture({ velocityTexture: velocityTarget(format), velocityHasPreviousDepth: true });
            f.frame();
            const data = f.history().data;
            expect(data[51]).toBe(1);
            expect(data[84]).toBe(format === "rgba16float" ? Math.fround(2 ** -10) : Math.fround(1e-5));
            expect(data[85]).toBe(format === "rgba16float" ? Math.fround(2 ** -10) : 0);
        }
        expect(() => fixture({ velocityTexture: velocityTarget(), velocityHasPreviousDepth: 1 as never })).toThrow("must be a boolean");
        expect(() => fixture({ velocityTexture: velocityTarget(), velocityHasPreviousDepth: null as never })).toThrow("must be a boolean");
    });
    it("uploads the static previous-depth reprojection rows", () => {
        const f = fixture();
        f.frame();
        f.frame();
        const data = f.history().data;
        const inverseVP = data.subarray(52, 68);
        const previousVP = data.subarray(32, 48);
        for (let column = 0; column < 4; column++) {
            let w = 0;
            for (let k = 0; k < 4; k++) w += previousVP[k * 4 + 3]! * inverseVP[column * 4 + k]!;
            expect(Math.abs(data[88 + column]! - w)).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(w)));
            expect(data[92 + column]).toBe(inverseVP[column * 4 + 3]);
        }
    });
    it("captures the velocity/depth contract and keeps it through live toggles", () => {
        const velocity = velocityTarget();
        const options = { velocityTexture: velocity, velocityHasPreviousDepth: true, historySamples: 8 };
        const f = fixture(options);
        options.velocityTexture = velocityTarget("rg16float");
        options.velocityHasPreviousDepth = false;
        options.historySamples = 16;
        f.frame();
        expect(f.history().data[51]).toBe(1);
        expect(f.task.temporal.historySamples).toBe(8);
        expect(getSsaoTemporalEntry(f.task)!.velocity).toBe(velocity);
        f.task.temporal.enabled = false;
        f.frame();
        f.task.temporal.enabled = true;
        f.frame();
        expect(f.history().data[51]).toBe(1);
        const other = fixture({ velocityTexture: velocity });
        other.frame();
        expect(other.history().data[51]).toBe(0);
    });
    it("releases previous owners on resize/device replacement and disposes once", () => {
        const f = fixture();
        f.frame();
        const old = f.history();
        const next = { ...f.gpu, width: 17, resolveGroup: {} } as SsaoGpu;
        f.task._filter!.prepare(next, f.params);
        expect(calls.dispose).toHaveBeenCalledWith(old);
        expect(f.params.phase).toBe(0);
        f.task.dispose();
        f.task.dispose();
        expect(calls.dispose).toHaveBeenCalledTimes(2);
        expect(getSsaoTemporalEntry(f.task)).toBeUndefined();
        expect(() => f.frame()).toThrow("disposed");
    });
    it("rejects unsupported floating-origin reconstruction, including live re-enable", () => {
        expect(() => fixture(undefined, true)).toThrow("floating-origin");
        const f = fixture(false, true);
        expect(f.frame()).toBe(0);
        expect(calls.create).not.toHaveBeenCalled();
        f.task.temporal.enabled = true;
        expect(() => f.frame()).toThrow("floating-origin");
        expect(calls.create).not.toHaveBeenCalled();
        const active = fixture();
        Object.assign(active.engine, { useFloatingOrigin: true });
        expect(() => active.frame()).toThrow("floating-origin");
    });
});
