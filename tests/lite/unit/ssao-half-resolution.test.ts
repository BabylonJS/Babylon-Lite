import { describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createSsaoTask } from "../../../packages/babylon-lite/src/post-process/ssao.js";
import { enableSsaoHalfResolution } from "../../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import { enableSsaoHalfPipeline } from "../../../packages/babylon-lite/src/post-process/ssao-half-pipeline.js";
import { createSsaoGpu, executeSsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { enableSsaoTemporal } from "../../../packages/babylon-lite/src/post-process/ssao-temporal.js";

function fixture(width = 339, height = 225) {
    const textures: GPUTexture[] = [];
    const device = {
        limits: { maxTextureDimension2D: 8192 },
        features: new Set(),
        queue: { writeBuffer: vi.fn() },
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const size = descriptor.size;
            const dims = Array.isArray(size) ? { width: size[0]!, height: size[1]! } : (size as GPUExtent3DDict);
            const texture = {
                width: dims.width,
                height: dims.height ?? 1,
                label: descriptor.label ?? "",
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                createView: vi.fn(() => ({ texture })),
                destroy: vi.fn(),
            } as unknown as GPUTexture;
            textures.push(texture);
            return texture;
        }),
        createBuffer: () => ({ destroy: vi.fn() }),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
        createSampler: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
        createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    } as unknown as GPUDevice;
    const renderPasses: GPURenderPassDescriptor[] = [];
    const stages: string[] = [];
    const encoder = {
        beginComputePass: (descriptor: GPUComputePassDescriptor = {}) => {
            stages.push(descriptor.label ?? "compute");
            return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
        },
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
            renderPasses.push(descriptor);
            stages.push("render");
            return { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), drawIndirect: vi.fn(), end: vi.fn() };
        },
    } as unknown as GPUCommandEncoder;
    const engine = { _device: device, _currentEncoder: encoder } as EngineContext;
    const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width, height } });
    depth._depthTexture = device.createTexture({ size: [width, height], format: "depth32float", usage: 0 });
    depth._width = width;
    depth._height = height;
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const task = createSsaoTask({ depthTexture: depth, camera }, engine);
    return { engine, device, depth, task, textures, renderPasses, stages };
}

describe("true half-pipeline SSAO", () => {
    it.each([true, false])("reduces working/history textures and upsamples after filtering (temporal=%s)", (temporal) => {
        const f = fixture();
        const settings = enableSsaoHalfPipeline(f.task);
        expect(enableSsaoHalfPipeline(f.task)).toBe(settings);
        if (temporal) enableSsaoTemporal(f.task);
        const target = f.task.outputTexture;
        f.task.execute!();
        expect(settings.active).toBe(true);
        expect([f.task._gpu!.width, f.task._gpu!.height]).toEqual([170, 113]);
        expect([target._width, target._height]).toEqual([339, 225]);
        expect(f.task._gpu!.kind).toBe("float");
        expect(f.task._gpu!.data[6]! / f.task._gpu!.data[7]!).toBeCloseTo(339 / 225, 5);
        const history = f.textures.filter((texture) => texture.label.startsWith("ssao-history"));
        expect(history.length > 0).toBe(temporal);
        for (const texture of history) expect([texture.width, texture.height]).toEqual([170, 113]);
        expect(f.stages.at(-1)).toBe("ssao-half-pipeline-upsample");
        if (temporal) expect(f.stages.indexOf("ssao-half-pipeline-upsample")).toBeGreaterThan(f.stages.lastIndexOf("render"));
        const allocations = f.textures.length;
        const groups = vi.mocked(f.device.createBindGroup).mock.calls.length;
        f.task.quality = "ultra";
        f.task.execute!();
        expect(f.textures).toHaveLength(allocations);
        expect(f.device.createBindGroup).toHaveBeenCalledTimes(groups);
        expect(f.task.outputTexture).toBe(target);
        f.task.dispose();
        for (const texture of f.textures) expect(texture.destroy).toHaveBeenCalledTimes(texture === f.depth._depthTexture ? 0 : 1);
    });
    it("keeps reduced normals and exact-depth velocity aligned with the reduced receiver", () => {
        const f = fixture();
        const input = (format: GPUTextureFormat) => {
            const result = createRenderTarget({ format, samples: 1, size: { width: 339, height: 225 } });
            result._colorTexture = f.device.createTexture({ size: [339, 225], format, usage: 0 });
            result._colorView = result._colorTexture.createView();
            result._width = 339;
            result._height = 225;
            return result;
        };
        const normal = input("rgba32float");
        const velocity = input("rgba32float");
        f.task.normalTexture = normal;
        enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
        enableSsaoHalfPipeline(f.task);
        f.task.execute!();
        expect(f.task._gpu!.sourceVelocity).toBeDefined();
        // Copies keep each source's precision: 32-bit inputs stay RGBA32F.
        for (const label of ["ssao-half-pipeline-normal", "ssao-half-pipeline-velocity"]) {
            const texture = f.textures.find((texture) => texture.label === label)!;
            expect([texture.width, texture.height, texture.format]).toEqual([170, 113, "rgba32float"]);
        }
        expect(f.task._gpu!.depthPrepared).toBe(true);
        f.task.dispose();
        expect(normal._colorTexture!.destroy).not.toHaveBeenCalled();
        expect(velocity._colorTexture!.destroy).not.toHaveBeenCalled();
    });
    it("copies half-float producer inputs exactly into half-float reduced inputs", () => {
        const f = fixture();
        const input = (format: GPUTextureFormat) => {
            const result = createRenderTarget({ format, samples: 1, size: { width: 339, height: 225 } });
            result._colorTexture = f.device.createTexture({ size: [339, 225], format, usage: 0 });
            result._colorView = result._colorTexture.createView();
            result._width = 339;
            result._height = 225;
            return result;
        };
        f.task.normalTexture = input("rgba16float");
        enableSsaoTemporal(f.task, { velocityTexture: input("rgba16float"), velocityHasPreviousDepth: true });
        enableSsaoHalfPipeline(f.task);
        f.task.execute!();
        for (const label of ["ssao-half-pipeline-normal", "ssao-half-pipeline-velocity"]) {
            expect(f.textures.find((texture) => texture.label === label)!.format).toBe("rgba16float");
        }
        f.task.dispose();
    });
    it("falls back to a real Full depth pipeline at small sizes and supports toggling", () => {
        const f = fixture();
        const settings = enableSsaoHalfPipeline(f.task);
        enableSsaoTemporal(f.task);
        f.task.execute!();
        f.depth._width = 170;
        f.depth._height = 113;
        f.depth._depthTexture = f.device.createTexture({ size: [170, 113], format: "depth32float", usage: 0 });
        f.task.execute!();
        expect(settings.active).toBe(false);
        expect(f.task._gpu!.kind).toBe("depth");
        f.depth._width = 339;
        f.depth._height = 225;
        f.depth._depthTexture = f.device.createTexture({ size: [339, 225], format: "depth32float", usage: 0 });
        for (const enabled of [true, false, true]) {
            settings.enabled = enabled;
            f.task.execute!();
            expect(settings.active).toBe(enabled);
            expect(f.task._gpu!.width).toBe(enabled ? 170 : 339);
        }
        f.task.dispose();
        expect(() => enableSsaoHalfPipeline(f.task)).toThrow("disposed");
    });
    it("does not replace an already installed resolution adapter", () => {
        const f = fixture();
        enableSsaoHalfResolution(f.task);
        expect(() => enableSsaoHalfPipeline(f.task)).toThrow("already installed");
        f.task.dispose();
    });
    it("recreates reduced inputs and histories on normal availability and device changes", () => {
        const f = fixture();
        const replacement = fixture();
        enableSsaoHalfPipeline(f.task);
        enableSsaoTemporal(f.task);
        f.task.execute!();
        const target = f.task.outputTexture;
        const first = f.task._gpu!;
        const normal = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 339, height: 225 } });
        normal._colorTexture = f.device.createTexture({ size: [339, 225], format: "rgba32float", usage: 0 });
        normal._colorView = normal._colorTexture.createView();
        normal._width = 339;
        normal._height = 225;
        f.task.normalTexture = normal;
        f.task.execute!();
        expect(f.task._gpu).not.toBe(first);
        expect(first.visibility.destroy).toHaveBeenCalledOnce();
        expect(f.task._gpu!.providedNormals).toBe(true);
        f.task.normalTexture = null;
        Object.assign(f.engine, { _device: replacement.device });
        f.depth._depthTexture = replacement.depth._depthTexture;
        f.task.execute!();
        expect(f.task._gpu!.device).toBe(replacement.device);
        // Without supplied normals the prepare pass reconstructs them once; reduced stages read that copy.
        expect(f.task._gpu!.providedNormals).toBe(true);
        expect(f.task._gpu!.worldNormals).toBe(false);
        const prepare = vi.mocked(replacement.device.createShaderModule).mock.calls.find(([descriptor]) => descriptor.label === "ssao-half-pipeline-prepare")![0];
        expect(String(prepare.code)).toContain("aoDepthNormal");
        expect(replacement.textures.find((texture) => texture.label === "ssao-half-pipeline-normal")!.format).toBe("rgba16float");
        expect(f.task.outputTexture).toBe(target);
        f.task.dispose();
        replacement.task.dispose();
        expect(normal._colorTexture.destroy).not.toHaveBeenCalled();
    });
});

describe("half-resolution SSAO ownership and lifecycle", () => {
    it.each([true, false])("allocates working textures only for the active estimator, retaining output/history (temporal=%s)", (enabledTemporal) => {
        const f = fixture(1920, 1080);
        const resolution = enableSsaoHalfResolution(f.task);
        const temporal = enableSsaoTemporal(f.task);
        temporal.enabled = enabledTemporal;
        f.task.execute!();
        const owner = f.task._gpu!,
            output = f.task.outputTexture._colorTexture;
        const history = f.textures.find((texture) => texture.label === "ssao-history-geometry-0");
        const working = () => f.textures.filter((texture) => texture.label === "ssao-working-ao-edges");
        expect(owner.working).toBeNull();
        expect(owner.estimatorGroup).toBeNull();
        expect(owner.resolveGroup).toBeNull();
        expect(working().map((texture) => [texture.width, texture.height])).toEqual([[960, 540]]);
        expect(() => executeSsaoGpu(owner, f.engine._currentEncoder)).toThrow("estimation resources");
        for (const full of [true, false, true, false]) {
            resolution.enabled = !full;
            f.task.execute!();
            expect(f.task._gpu).toBe(owner);
            expect(f.task.outputTexture._colorTexture).toBe(output);
            expect(owner.working !== null).toBe(full);
            if (full) expect([owner.working!.width, owner.working!.height]).toEqual([1920, 1080]);
            const textures = f.textures.length,
                groups = vi.mocked(f.device.createBindGroup).mock.calls.length;
            f.task.execute!();
            expect(f.textures).toHaveLength(textures);
            expect(f.device.createBindGroup).toHaveBeenCalledTimes(groups);
            if (history) expect(history.destroy).not.toHaveBeenCalled();
        }
        for (const texture of working().filter((texture) => texture.width === 1920)) {
            expect(texture.destroy).toHaveBeenCalledOnce();
        }
        f.task.dispose();
        for (const texture of working()) expect(texture.destroy).toHaveBeenCalledOnce();
    });
    it("rebinds a previously enabled temporal owner across mode changes while temporal filtering is disabled", () => {
        const f = fixture();
        const resolution = enableSsaoHalfResolution(f.task),
            temporal = enableSsaoTemporal(f.task);
        f.task.execute!();
        temporal.enabled = false;
        for (const half of [false, true, false, true]) {
            resolution.enabled = half;
            f.task.execute!();
            expect(f.task._gpu!.resolveGroup === null).toBe(half);
            temporal.enabled = true;
            f.task.execute!();
            expect(f.task._gpu!.resolveGroup === null).toBe(half);
            temporal.enabled = false;
            f.task.execute!();
        }
        f.task.dispose();
    });
    it("retires existing Full working textures when the Half adapter is installed later", () => {
        const f = fixture();
        enableSsaoTemporal(f.task);
        f.task.execute!();
        const owner = f.task._gpu!,
            working = owner.working!,
            output = f.task.outputTexture._colorTexture;
        enableSsaoHalfResolution(f.task);
        f.task.execute!();
        expect(f.task._gpu).toBe(owner);
        expect(f.task.outputTexture._colorTexture).toBe(output);
        expect(working.destroy).toHaveBeenCalledOnce();
        expect(owner.working).toBeNull();
        f.task.dispose();
        expect(working.destroy).toHaveBeenCalledOnce();
    });
    it("allocates Full working textures at the small-viewport safeguard and removes them after growing", () => {
        const f = fixture();
        const resolution = enableSsaoHalfResolution(f.task);
        f.task.execute!();
        f.depth._width = 319;
        f.depth._depthTexture = f.device.createTexture({ size: [319, 225], format: "depth32float", usage: 0 });
        f.task.execute!();
        expect(resolution.active).toBe(false);
        const fallback = f.task._gpu!,
            working = fallback.working!;
        expect(working.width).toBe(319);
        f.depth._width = 339;
        f.depth._depthTexture = f.device.createTexture({ size: [339, 225], format: "depth32float", usage: 0 });
        f.task.execute!();
        expect(resolution.active).toBe(true);
        expect(f.task._gpu!.working).toBeNull();
        expect(working.destroy).toHaveBeenCalledOnce();
        f.task.dispose();
    });
    it("recreates sparse resources without Full working allocations after device replacement", () => {
        const f = fixture(),
            replacement = fixture();
        enableSsaoHalfResolution(f.task);
        enableSsaoTemporal(f.task);
        f.task.execute!();
        const original = f.task._gpu!,
            source = f.depth._depthTexture!;
        Object.assign(f.engine, { _device: replacement.device });
        f.depth._depthTexture = replacement.depth._depthTexture;
        f.task.execute!();
        expect(f.task._gpu!.device).toBe(replacement.device);
        expect(f.task._gpu).not.toBe(original);
        expect(f.task._gpu!.working).toBeNull();
        for (const texture of f.textures) expect(texture.destroy).toHaveBeenCalledTimes(texture === source ? 0 : 1);
        f.task.dispose();
        replacement.task.dispose();
    });
    it("rejects the retired quarter stride before allocating GPU resources", () => {
        const f = fixture();
        expect(() => Reflect.apply(createSsaoGpu, undefined, [f.device, 643, 449, "depth", false, false, 4])).toThrow("pixel stride");
        expect(f.device.createComputePipeline).not.toHaveBeenCalled();
        f.task.dispose();
    });
    it.each([true, false])("replaces full/half shader variants on normal-source changes (half=%s)", (half) => {
        const f = fixture();
        const resolution = enableSsaoHalfResolution(f.task);
        resolution.enabled = half;
        const normal = createRenderTarget({ format: "rgba16float", samples: 1, size: { width: 339, height: 225 } });
        normal._colorTexture = f.device.createTexture({ size: [339, 225], format: "rgba16float", usage: 0 });
        normal._colorView = normal._colorTexture.createView();
        normal._width = 339;
        normal._height = 225;
        f.task.normalTexture = normal;
        const temporal = enableSsaoTemporal(f.task);
        f.task.execute!();
        f.task.execute!();
        const supplied = f.task._gpu!,
            firstHistory = f.textures.find((texture) => texture.label === "ssao-history-geometry-0")!;
        const managed = f.task.outputTexture;
        f.task.normalTexture = null;
        f.task.execute!();
        expect(f.task._gpu!.providedNormals).toBe(false);
        expect(f.task._gpu).toBe(supplied);
        expect(supplied.visibility.destroy).not.toHaveBeenCalled();
        expect(firstHistory.destroy).toHaveBeenCalledOnce();
        const textureCount = f.textures.length;
        f.task.execute!();
        expect(f.textures).toHaveLength(textureCount);
        temporal.enabled = false;
        f.task.normalTexture = normal;
        f.task.execute!();
        temporal.enabled = true;
        f.task.execute!();
        expect(f.task._gpu!.providedNormals).toBe(true);
        expect(f.task.outputTexture).toBe(managed);
        const variants = vi
            .mocked(f.device.createComputePipeline)
            .mock.calls.map(([descriptor]) => descriptor.compute.constants)
            .filter((constants) => constants?.SLICE_COUNT !== undefined);
        expect(variants.map((constants) => constants!.PROVIDED_NORMALS)).toEqual([1, 0, 1]);
        expect(variants.every((constants) => constants!.PIXEL_STRIDE === (half ? 2 : 1))).toBe(true);
        const upsamplers = vi.mocked(f.device.createShaderModule).mock.calls.filter(([descriptor]) => descriptor.label === "ssao-half-upsample");
        expect(upsamplers.map(([descriptor]) => descriptor.code.includes("var<workgroup>"))).toEqual(half ? [false, true, false] : []);
        f.task.dispose();
        expect(normal._colorTexture.destroy).not.toHaveBeenCalled();
    });
    it("specializes and caches XeGTAO presets in sparse and full modes", () => {
        const f = fixture();
        const resolution = enableSsaoHalfResolution(f.task);
        const presets = [
            { quality: "low", slices: 1, steps: 2 },
            { quality: "medium", slices: 2, steps: 2 },
            { quality: "high", slices: 3, steps: 3 },
            { quality: "ultra", slices: 9, steps: 3 },
        ] as const;
        for (const sparse of [true, false]) {
            resolution.enabled = sparse;
            let resolveCount = 0;
            for (const { quality, slices, steps } of presets) {
                f.task.quality = quality;
                const start = vi.mocked(f.device.createComputePipeline).mock.calls.length;
                f.task.execute!();
                const allocations = vi.mocked(f.device.createComputePipeline).mock.calls.slice(start);
                const estimator = allocations.find(([descriptor]) => descriptor.compute.constants?.SLICE_COUNT !== undefined)?.[0];
                expect(estimator?.compute.constants).toEqual({ PROVIDED_NORMALS: 0, WORLD_NORMALS: 0, PIXEL_STRIDE: sparse ? 2 : 1, SLICE_COUNT: slices, STEP_COUNT: steps });
                resolveCount += allocations.filter(
                    ([descriptor]) => descriptor.compute.constants?.PIXEL_STRIDE !== undefined && descriptor.compute.constants.SLICE_COUNT === undefined
                ).length;
            }
            expect(resolveCount).toBe(1);
            const publicOutput = f.task.outputTexture._colorTexture,
                textures = f.textures.length,
                pipelines = vi.mocked(f.device.createComputePipeline).mock.calls.length;
            for (const { quality } of presets) {
                f.task.quality = quality;
                f.task.execute!();
            }
            expect(f.textures).toHaveLength(textures);
            expect(f.device.createComputePipeline).toHaveBeenCalledTimes(pipelines);
            expect(f.task.outputTexture._colorTexture).toBe(publicOutput);
        }
        // The depth chain is point-sampled; no filtering (float32-filterable) sampler is required.
        for (const [descriptor] of vi.mocked(f.device.createSampler).mock.calls) {
            expect([descriptor?.minFilter, descriptor?.magFilter, descriptor?.mipmapFilter].every((filter) => filter === undefined || filter === "nearest")).toBe(true);
            expect(descriptor).toMatchObject({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
        }
        expect(f.task._gpu!.data[26]).toBe(0);
        expect(f.task._gpu!.data[27]).toBe(0);
        f.task.dispose();
    });

    it.each([
        [63, 49],
        [1, 17],
        [17, 1],
        [1, 1],
    ])("reports full-resolution quality fallback at small %sx%s targets", (width, height) => {
        const f = fixture(width, height);
        const settings = enableSsaoHalfResolution(f.task);
        expect(enableSsaoHalfResolution(f.task)).toBe(settings);
        f.task.record();
        expect(settings.active).toBe(false);
        expect(f.task._gpu!.width).toBe(width);
        expect(f.task._gpu!.height).toBe(height);
        expect(f.task.outputTexture._width).toBe(width);
        expect(f.task.outputTexture._height).toBe(height);
        expect(f.task.outputTexture._colorTexture).toBe(f.task._gpu!.visibility);
        f.task.dispose();
    });

    it("does not reallocate resources on unchanged frames and restores the original full-size path", () => {
        const f = fixture();
        const settings = enableSsaoHalfResolution(f.task);
        f.task.record();
        f.task.execute!();
        const first = f.task._gpu!;
        expect(settings.active).toBe(true);
        expect(f.textures.some((texture) => texture.label === "ssao-working-ao-edges" && texture.width === 170 && texture.height === 113)).toBe(true);
        const allocated = f.textures.length;
        f.task.execute!();
        expect(f.textures.length).toBe(allocated);
        expect(f.task._gpu).toBe(first);
        settings.enabled = false;
        f.task.execute!();
        expect(f.task._gpu!.width).toBe(339);
        expect(f.task._gpu!.outputTexture).toBeUndefined();
        expect(first.visibility.destroy).not.toHaveBeenCalled();
        settings.enabled = true;
        f.task.execute!();
        expect(f.task._gpu).toBe(first);
        expect(f.task.outputTexture._width).toBe(339);
        f.task.dispose();
    });

    it("retains full-size temporal geometry, history and original motion", () => {
        const f = fixture();
        const velocity = createRenderTarget({ format: "rgba32float", samples: 1, size: { width: 339, height: 225 } });
        velocity._colorTexture = f.device.createTexture({ size: [339, 225], format: "rgba32float", usage: 0 });
        velocity._colorView = velocity._colorTexture.createView();
        velocity._width = 339;
        velocity._height = 225;
        const temporal = enableSsaoTemporal(f.task, { velocityTexture: velocity, velocityHasPreviousDepth: true });
        enableSsaoHalfResolution(f.task);
        f.task.record();
        f.task.execute!();
        expect(f.task._gpu!.sourceVelocity).toBeUndefined();
        expect(f.textures.find((texture) => texture.label === "ssao-history-0")!.width).toBe(339);
        const publicOutput = f.task.outputTexture._colorTexture;
        temporal.enabled = false;
        f.task.execute!();
        temporal.enabled = true;
        f.task.execute!();
        expect(f.task.outputTexture._colorTexture).toBe(publicOutput);
        velocity._width = 32;
        expect(() => f.task.execute!()).toThrow("identical dimensions");
        f.task.dispose();
    });

    it("clears the full public output on AO disable and destroys each owned allocation once", () => {
        const f = fixture();
        enableSsaoHalfResolution(f.task);
        f.task.record();
        f.task.enabled = false;
        f.task.execute!();
        const cleared = f.renderPasses.find((pass) => pass.label === "ssao-disabled")!;
        const attachment = Array.from(cleared.colorAttachments)[0]!;
        expect(attachment.view).toEqual({ texture: f.task.outputTexture._colorTexture });
        const borrowed = f.depth._depthTexture!;
        f.task.dispose();
        f.task.dispose();
        for (const texture of f.textures) {
            expect(texture.destroy).toHaveBeenCalledTimes(texture === borrowed ? 0 : 1);
        }
        expect(() => enableSsaoHalfResolution(f.task)).toThrow("disposed");
    });

    it("replaces working and public allocations on odd-size resize", () => {
        const f = fixture();
        enableSsaoHalfResolution(f.task);
        f.task.record();
        const original = f.task._gpu!;
        f.depth._width = 341;
        f.depth._height = 227;
        f.depth._depthTexture = f.device.createTexture({ size: [341, 227], format: "depth32float", usage: 0 });
        f.task.record();
        expect(f.task._gpu!.width).toBe(341);
        expect(f.task._gpu!.height).toBe(227);
        expect(f.task.outputTexture._width).toBe(341);
        expect(original.visibility.destroy).toHaveBeenCalledOnce();
        f.task.dispose();
    });
});
