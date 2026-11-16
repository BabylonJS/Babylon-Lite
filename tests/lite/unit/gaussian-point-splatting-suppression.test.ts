import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";
import type { GaussianPointSplatting } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-state.js";
import { installGpsDrawSuppression } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-suppression.js";
import { createSplatStreamDrawBatch, createSplatStreamGpuState } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu.js";
import type { GaussianSplatStream } from "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-types.js";
import { postSplatSortIfDirty, uploadPendingSplatOrder, type GaussianSplattingMesh } from "../../../packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CONTEXT = { targetWidth: 16, targetHeight: 16 };

function sceneWith(classic: Renderable): SceneContext {
    return { _renderables: [classic], _renderableVersion: 0, _beforeRender: [] } as unknown as SceneContext;
}

function pointHandle(target: GaussianSplattingMesh | GaussianSplatStream): GaussianPointSplatting {
    return { _target: target, colorRenderMode: true, _disabled: false } as GaussianPointSplatting;
}

function staticFixture() {
    const jobs: { t: Float32Array; o: Uint32Array }[] = [];
    const queue = { writeBuffer: vi.fn() } as unknown as GPUQueue;
    const engine = {} as EngineContext;
    const view = IDENTITY.slice();
    let resolveFirst!: () => void;
    const firstSortReady = new Promise<void>((resolve) => {
        resolveFirst = resolve;
    });
    const mesh = {
        _gs: { _splatIndexBuffer: {}, _splatIndexCpu: new Float32Array(3) },
        _orderPool: [new Uint32Array(3), new Uint32Array(3)],
        _pendingOrder: null,
        _sortDepthTransform: new Float32Array(4),
        _nextSortDepthTransform: new Float32Array(4),
        _firstSortResolve: resolveFirst,
        firstSortReady,
        _worker: {
            postMessage(job: { t: Float32Array; o: Uint32Array }) {
                jobs.push({ t: job.t.slice(), o: job.o });
            },
        },
    } as unknown as GaussianSplattingMesh;
    const update = vi.fn(() => {
        uploadPendingSplatOrder(queue, mesh);
        postSplatSortIfDirty(mesh, IDENTITY, view);
    });
    const pass = { setVertexBuffer: vi.fn(), drawIndexed: vi.fn() } as unknown as GPURenderPassEncoder;
    const classic: Renderable = {
        order: 200,
        isTransparent: true,
        bind() {
            return {
                renderable: classic,
                pipeline: {} as GPURenderPipeline,
                update,
                draw(encoder) {
                    encoder.setVertexBuffer(1, mesh._gs._splatIndexBuffer);
                    encoder.drawIndexed(6, 3);
                    return 1;
                },
            };
        },
    };
    const original = classic.bind;
    const scene = sceneWith(classic);
    const gps = pointHandle(mesh);
    const remove = installGpsDrawSuppression(scene, gps, {} as Renderable);
    const binding = classic.bind(engine, {} as RenderTargetSignature);
    const frame = () => {
        binding.update?.(CONTEXT);
        return binding.draw(pass, engine);
    };
    const complete = (index: number) => {
        const order = jobs[index]!.o;
        order.set([2, 1, 0]);
        if (mesh._pendingOrder) {
            mesh._orderPool.push(mesh._pendingOrder);
        }
        mesh._pendingOrder = order;
        mesh._firstSortResolve?.();
        mesh._firstSortResolve = null;
    };
    return { scene, gps, mesh, jobs, queue, update, pass, classic, original, engine, view, binding, frame, complete, remove };
}

describe("point-only classic work suppression", () => {
    it("preserves first-sort readiness, then stops static worker sorts and order uploads", async () => {
        const fixture = staticFixture();
        expect(fixture.frame()).toBe(0);
        expect(fixture.jobs).toHaveLength(1);
        fixture.complete(0);
        await fixture.mesh.firstSortReady;
        fixture.update.mockClear();
        fixture.view[14] = 5;
        for (let frame = 0; frame < 3; frame++) {
            expect(fixture.frame()).toBe(0);
        }
        expect(fixture.update).not.toHaveBeenCalled();
        expect(fixture.queue.writeBuffer).not.toHaveBeenCalled();
        expect(fixture.jobs).toHaveLength(1);
        fixture.remove();
    });

    it("drains stale worker results and uploads a fresh current-view order before reactivating classic drawing", () => {
        const fixture = staticFixture();
        fixture.frame();
        fixture.view[14] = 1;
        fixture.frame();
        expect(fixture.jobs).toHaveLength(2);
        fixture.complete(0);
        fixture.frame();
        fixture.gps.colorRenderMode = false;
        fixture.view[14] = 2;
        expect(fixture.frame()).toBe(0);
        expect(fixture.jobs).toHaveLength(2);
        expect(fixture.queue.writeBuffer).not.toHaveBeenCalled();
        fixture.complete(1);
        expect(fixture.frame()).toBe(0);
        expect(fixture.jobs).toHaveLength(3);
        expect(fixture.jobs[2]!.t[3]).toBe(2);
        expect(fixture.frame()).toBe(0);
        expect(fixture.queue.writeBuffer).not.toHaveBeenCalled();
        fixture.complete(2);
        expect(fixture.frame()).toBe(1);
        expect(fixture.queue.writeBuffer).toHaveBeenCalledOnce();
        expect(fixture.pass.drawIndexed).toHaveBeenCalledOnce();
        expect(Array.from(fixture.mesh._gs._splatIndexCpu)).toEqual([2, 1, 0]);
        fixture.remove();
        expect(fixture.classic.bind).toBe(fixture.original);
    });

    it("resumes normal asynchronous sorting if the view keeps moving after reactivation", () => {
        const fixture = staticFixture();
        fixture.frame();
        fixture.complete(0);
        fixture.frame();
        fixture.gps.colorRenderMode = false;
        expect(fixture.frame()).toBe(0);
        fixture.view[14] = 3;
        fixture.complete(1);
        expect(fixture.frame()).toBe(1);
        expect(fixture.jobs).toHaveLength(3);
        expect(fixture.jobs[2]!.t[3]).toBe(3);
        fixture.complete(2);
        expect(fixture.frame()).toBe(1);
        fixture.remove();
    });

    it("retains the fresh-sort gate for both rebound and cached bindings after disabling", () => {
        const fixture = staticFixture();
        fixture.frame();
        fixture.complete(0);
        fixture.frame();
        fixture.gps._disabled = true;
        fixture.remove();
        expect(fixture.scene._beforeRender).toHaveLength(0);
        expect(fixture.classic.bind).not.toBe(fixture.original);
        const rebound = fixture.classic.bind(fixture.engine, {} as RenderTargetSignature);
        rebound.update?.(CONTEXT);
        expect(rebound.draw(fixture.pass, fixture.engine)).toBe(0);
        expect(fixture.binding.draw(fixture.pass, fixture.engine)).toBe(0);
        fixture.complete(1);
        rebound.update?.(CONTEXT);
        expect(rebound.draw(fixture.pass, fixture.engine)).toBe(1);
        expect(fixture.binding.draw(fixture.pass, fixture.engine)).toBe(1);
        expect(fixture.classic.bind).toBe(fixture.original);
        expect(fixture.queue.writeBuffer).toHaveBeenCalledOnce();
    });

    it.each(["color off", "disable"])("preserves stream bootstrap/gather, skips projection/compaction/radix work, and resumes on %s", (mode) => {
        const labels: string[] = [];
        const compute = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn(),
            dispatchWorkgroupsIndirect: vi.fn(),
            end: vi.fn(),
        };
        const device = {
            limits: { maxBufferSize: 1 << 27, maxStorageBufferBindingSize: 1 << 27, maxComputeWorkgroupsPerDimension: 65535 },
            queue: { writeBuffer: vi.fn() },
            createBuffer(descriptor: GPUBufferDescriptor) {
                return { getMappedRange: () => new ArrayBuffer(descriptor.size), unmap: vi.fn(), destroy: vi.fn() };
            },
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createBindGroup: vi.fn(() => ({})),
            createShaderModule: vi.fn(() => ({})),
            createComputePipeline: vi.fn(() => ({})),
        };
        const engine = {
            _device: device,
            _currentEncoder: {
                copyBufferToBuffer: vi.fn(),
                clearBuffer: vi.fn(),
                beginComputePass(descriptor: GPUComputePassDescriptor) {
                    labels.push(descriptor.label!);
                    return compute;
                },
            },
        } as unknown as EngineContext;
        const state = createSplatStreamGpuState(engine, 3, 1 << 20);
        state.count = 3;
        state.intervals = [
            {
                count: 3,
                sourceOffset: 0,
                destinationOffset: 0,
                source: { width: 3, views: [{}, {}, {}, {}, {}], codebooks: {}, meansMin: [0, 0, 0], meansMax: [1, 1, 1] },
            },
        ] as unknown as typeof state.intervals;
        const batch = createSplatStreamDrawBatch(state, {} as RenderTargetSignature);
        const originalQueue = batch.queue;
        // The batch's bootstrap signal is consumed by the same original draw notification as the loader.
        state.bootstrapReadbackHoldBytes = 0;
        batch.passGpu.bootstrapSignal = Promise.resolve(true);
        const selection = vi.fn();
        const notification = vi.fn();
        let key = "bootstrap";
        const stream = { _gpu: state, _coarseSubmitted: false } as GaussianSplatStream;
        const classic: Renderable = {
            order: 200,
            isTransparent: true,
            bind() {
                return {
                    renderable: classic,
                    pipeline: {} as GPURenderPipeline,
                    _updateBatches: [batch],
                    update() {
                        selection();
                        batch.queue({ count: state.count, key, worldView: IDENTITY, projection: IDENTITY, width: 16, height: 16, near: 0.1 });
                    },
                    draw(pass) {
                        pass.drawIndirect(batch.passGpu.indirect, 0);
                        const signal = batch.takeBootstrapSignal();
                        if (signal) {
                            notification(signal);
                            stream._coarseSubmitted = true;
                        }
                        return 1;
                    },
                };
            },
        };
        stream._renderable = classic;
        const scene = sceneWith(classic);
        const gps = pointHandle(stream);
        const remove = installGpsDrawSuppression(scene, gps, {} as Renderable);
        const binding = classic.bind(engine, {} as RenderTargetSignature);
        expect(binding._updateBatches).toEqual([batch]);
        const wrappedQueue = batch.queue;
        classic.bind(engine, {} as RenderTargetSignature);
        expect(batch.queue).toBe(wrappedQueue);
        const pass = { drawIndirect: vi.fn() } as unknown as GPURenderPassEncoder;
        const frame = () => {
            labels.length = 0;
            batch.reset();
            binding.update?.(CONTEXT);
            batch.flush(engine);
            return binding.draw(pass, engine);
        };
        expect(frame()).toBe(0);
        expect(notification).toHaveBeenCalledOnce();
        expect(stream._coarseSubmitted).toBe(true);
        expect(labels).toContain("splat stream projection");
        expect(labels).toContain("splat stream compact scatter");
        expect(labels.filter((label) => label === "splat stream radix bases")).toHaveLength(8);
        state.contentGeneration++;
        key = "refined-content-and-moved-view";
        expect(frame()).toBe(0);
        expect(labels).toEqual(["splat stream gather"]);
        expect(state.gatheredGeneration).toBe(state.contentGeneration);
        expect(batch.passGpu.lastKey).toBe("bootstrap");
        expect(frame()).toBe(0);
        expect(labels).toEqual([]);
        expect(selection).toHaveBeenCalledTimes(3);
        if (mode === "disable") {
            gps._disabled = true;
            remove();
        } else {
            gps.colorRenderMode = false;
        }
        expect(frame()).toBe(1);
        expect(labels).toContain("splat stream projection");
        expect(labels).toContain("splat stream compact scatter");
        expect(labels.filter((label) => label === "splat stream radix bases")).toHaveLength(8);
        expect(batch.passGpu.lastKey).toBe(key);
        expect(pass.drawIndirect).toHaveBeenCalledOnce();
        remove();
        expect(batch.queue).toBe(originalQueue);
    });
});
