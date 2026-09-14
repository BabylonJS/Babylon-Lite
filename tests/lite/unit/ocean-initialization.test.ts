import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Lite from "../../../packages/babylon-lite/src/index";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { createOceanComputeResources, disposeOceanComputeResources } from "../../../lab/lite/src/demos/ocean/resources";
import { createOceanSimulation } from "../../../lab/lite/src/demos/ocean/simulation";
import { createOceanResourceScope, disposeOceanScope, ownOceanResource } from "../../../lab/lite/src/demos/ocean/ownership";
import { disposeOceanDemoResources } from "../../../lab/lite/src/demos/ocean/lifecycle";
import { retireGpuResources } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";

const created = vi.hoisted(() => ({
    shaders: [] as Lite.ComputeShader[],
    bindings: [] as Lite.ComputeBindingSet[],
    tasks: [] as Lite.ComputeTask[],
}));

vi.mock("../../../packages/babylon-lite/src/index.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof Lite>();
    return {
        ...actual,
        createComputeShader: (...args: Parameters<typeof actual.createComputeShader>) => {
            const resource = actual.createComputeShader(...args);
            created.shaders.push(resource);
            return resource;
        },
        createComputeBindingSet: (...args: Parameters<typeof actual.createComputeBindingSet>) => {
            const resource = actual.createComputeBindingSet(...args);
            created.bindings.push(resource);
            return resource;
        },
        createComputeTask: (...args: Parameters<typeof actual.createComputeTask>) => {
            const resource = actual.createComputeTask(...args);
            created.tasks.push(resource);
            return resource;
        },
    };
});

function fixture() {
    const textures: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    const fail = { texture: -1, bufferLabel: "", bindingLabel: "", shader: false };
    let textureCount = 0;
    const device = {
        features: new Set(),
        limits: {
            maxBufferSize: 16 * 1024 * 1024,
            maxTextureDimension2D: 4096,
            maxStorageBufferBindingSize: 16 * 1024 * 1024,
            maxUniformBufferBindingSize: 65536,
            minStorageBufferOffsetAlignment: 256,
            minUniformBufferOffsetAlignment: 256,
            maxComputeWorkgroupsPerDimension: 65535,
            maxBindGroups: 4,
            maxBindingsPerBindGroup: 16,
        },
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            if (++textureCount === fail.texture) throw new Error("texture allocation failed");
            const texture = {
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                sampleCount: 1,
                usage: descriptor.usage,
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            } as unknown as GPUTexture;
            textures.push(texture);
            return texture;
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            if (fail.bufferLabel && descriptor.label === fail.bufferLabel) throw new Error("buffer allocation failed");
            const mapped = new ArrayBuffer(Number(descriptor.size));
            const buffer = { label: descriptor.label, size: descriptor.size, getMappedRange: () => mapped, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        destroy: vi.fn(),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            if (fail.bindingLabel && descriptor.label?.includes(fail.bindingLabel)) throw new Error("binding failed");
            return descriptor as unknown as GPUBindGroup;
        }),
        createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
        createComputePipelineAsync: vi.fn(async () => {
            if (fail.shader) throw new Error("shader failed");
            return {} as GPUComputePipeline;
        }),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        queue: { writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(async (): Promise<void> => undefined) },
    };
    return { engine: { _device: device } as unknown as Lite.EngineContext, device, fail, textures, buffers };
}

function expectReleased(f: ReturnType<typeof fixture>) {
    for (const resource of [...f.textures, ...f.buffers]) {
        expect(resource.destroy).toHaveBeenCalledOnce();
    }
    for (const shader of created.shaders) expect(shader._destroyed).toBe(true);
    for (const bindings of created.bindings) expect(bindings._destroyed).toBe(true);
    for (const task of created.tasks) {
        expect(task._disposed).toBe(true);
        expect(task._uniformArenas).toBeUndefined();
        expect(task._dispatches).toHaveLength(0);
    }
    expect(f.engine._storageBuffers).toBeUndefined();
}

beforeEach(() => {
    created.shaders.length = created.bindings.length = created.tasks.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0x094b + 256 * (8 + 256 * 16)),
        }))
    );
});
afterEach(() => vi.unstubAllGlobals());

describe("Ocean construction ownership", () => {
    it.each([false, true])("drains deferred sampled owners before demo teardown (registered tasks disposed: %s)", async (registered) => {
        const f = fixture();
        Object.assign(f.engine, { _surfaces: [], _animFrameId: 0 });
        const simulation = await createOceanSimulation(f.engine, 8);
        if (registered) {
            for (const task of created.tasks) task.dispose();
        }
        const sampled = simulation.resources.cascades[0].displacement.sampledTexture!;
        acquireTexture(sampled);
        const release = vi.fn(() => releaseTexture(sampled));
        retireGpuResources(f.engine, release);
        let finishOriginalFence!: () => void;
        const originalFence = new Promise<void>((resolve) => {
            finishOriginalFence = resolve;
        });
        f.device.queue.onSubmittedWorkDone.mockReturnValueOnce(originalFence);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await disposeOceanDemoResources(f.engine, simulation);
            expect(release).toHaveBeenCalledOnce();
            expect(f.device.destroy).toHaveBeenCalledOnce();
            expectReleased(f);
            expect(error).not.toHaveBeenCalled();
            finishOriginalFence();
            await Promise.resolve();
            expect(release).toHaveBeenCalledOnce();
        } finally {
            error.mockRestore();
        }
    });

    it.each([1, 6, 23, 46])("rolls back every earlier texture if allocation %i fails", async (at) => {
        const f = fixture();
        f.fail.texture = at;
        await expect(createOceanComputeResources(f.engine, 8, 3)).rejects.toThrow(/texture allocation failed/);
        expect(f.textures).toHaveLength(at - 1);
        expectReleased(f);
        f.fail.texture = -1;
        const resources = await createOceanComputeResources(f.engine, 8, 3);
        disposeOceanComputeResources(resources);
        disposeOceanComputeResources(resources);
        expectReleased(f);
    });

    it.each(["download", "decode"])("fails during noise %s before creating GPU resources", async (failure) => {
        const f = fixture();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => (failure === "download" ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }))
        );
        await expect(createOceanSimulation(f.engine, 8)).rejects.toThrow();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(f.device.createBuffer).not.toHaveBeenCalled();
        expect(created.tasks).toHaveLength(0);
    });

    it.each(["ocean-gaussian-noise", "ocean-spectrum-settings", "ocean-time-params", "ocean-buoy-probe-params"])(
        "rolls back partial simulation construction at %s",
        async (label) => {
            const f = fixture();
            f.fail.bufferLabel = label;
            await expect(createOceanSimulation(f.engine, 8)).rejects.toThrow("buffer allocation failed");
            expect(f.textures).toHaveLength(46);
            expectReleased(f);
        }
    );

    it.each(["binding", "shader"])("rolls back %s preparation failures and supports a clean retry", async (failure) => {
        const f = fixture();
        f.fail.bindingLabel = failure === "binding" ? "ocean-fft-vertical" : "";
        f.fail.shader = failure === "shader";
        await expect(createOceanSimulation(f.engine, 8)).rejects.toThrow(failure === "binding" ? "binding failed" : "shader preparation failed");
        expectReleased(f);
        f.fail.bindingLabel = "";
        f.fail.shader = false;
        const simulation = await createOceanSimulation(f.engine, 8);
        simulation.dispose();
        simulation.dispose();
        expectReleased(f);
    });

    it("owns the complete successful graph and rejects work after disposal", async () => {
        const f = fixture();
        const simulation = await createOceanSimulation(f.engine, 8);
        expect(f.textures).toHaveLength(46);
        expect(created.tasks).toHaveLength(4);
        expect(f.device.createComputePipelineAsync).toHaveBeenCalled();
        simulation.dispose();
        await expect(simulation.initialization.completion).rejects.toThrow(/disposed/);
        expectReleased(f);
        expect(() => simulation.update(1, 1 / 60)).toThrow(/disposed/);
        await expect(simulation.readBuoyancy()).rejects.toThrow(/disposed/);
        await expect(simulation.warmup(1)).rejects.toThrow(/disposed/);
        simulation.dispose();
        expectReleased(f);
    });

    it("settles all shader preparations before rolling back a failed graph", async () => {
        const f = fixture();
        let finishShader!: (pipeline: GPUComputePipeline) => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        vi.mocked(f.device.createComputePipelineAsync)
            .mockRejectedValueOnce(new Error("first shader failed"))
            .mockImplementationOnce(() => {
                started();
                return new Promise<GPUComputePipeline>((resolve) => {
                    finishShader = resolve;
                });
            });
        const creating = createOceanSimulation(f.engine, 8);
        await entered;
        for (const resource of [...f.textures, ...f.buffers]) {
            expect(resource.destroy).not.toHaveBeenCalled();
        }
        finishShader({} as GPUComputePipeline);
        await expect(creating).rejects.toThrow(/shader preparation failed/);
        expectReleased(f);
    });

    it("handles frame-graph task disposal before the aggregate teardown", async () => {
        const f = fixture();
        const simulation = await createOceanSimulation(f.engine, 8);
        const error = vi.spyOn(console, "error");
        try {
            simulation.initializationTask.dispose();
            await Promise.resolve();
            expect(error).not.toHaveBeenCalled();
            expect(() => simulation.update(0, 0)).toThrow(/disposed/);
            simulation.dispose();
            expectReleased(f);
        } finally {
            error.mockRestore();
        }
    });

    it("retains failed disposal entries so externally owned outputs can be released and retried", async () => {
        const f = fixture();
        const simulation = await createOceanSimulation(f.engine, 8);
        const sampled = simulation.resources.cascades[0].displacement.sampledTexture!;
        acquireTexture(sampled);
        expect(() => simulation.dispose()).toThrow(/cleanup failed/);
        expect(sampled.texture.destroy).not.toHaveBeenCalled();
        releaseTexture(sampled);
        simulation.dispose();
        expectReleased(f);
    });

    it("attempts every cleanup and retries only failures", () => {
        const scope = createOceanResourceScope();
        const first = vi.fn();
        const second = vi.fn().mockImplementationOnce(() => {
            throw new Error("busy");
        });
        const third = vi.fn();
        ownOceanResource(scope, 1, first);
        ownOceanResource(scope, 2, second);
        ownOceanResource(scope, 3, third);
        expect(() => disposeOceanScope(scope)).toThrow(/cleanup failed/);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(third).toHaveBeenCalledOnce();
        disposeOceanScope(scope);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledTimes(2);
        expect(third).toHaveBeenCalledOnce();
    });
});
