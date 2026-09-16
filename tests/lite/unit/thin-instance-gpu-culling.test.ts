import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry, updateMeshGeometryCapacity } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { tryBind } from "../../../packages/babylon-lite/src/mesh/thin-instance-cull-binding";
import { createTiCullState, getComputeDispatchBatch, prepareTiCull, publishTiLodBucket } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling";
import { clearThinInstanceLodPartner, setThinInstanceLodPartner, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { DrawBinding, DrawUpdateBatch, DrawUpdateContext, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function makeCamera(): Camera {
    return {
        fov: Math.PI / 3,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: identity(),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    };
}

function makeThinInstances(count: number): ThinInstanceData {
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
        matrices.set(identity(), i * 16);
    }
    return {
        matrices,
        count,
        _capacity: count,
        _version: 1,
        _gpuBuffer: null,
        _gpuBufferStorage: false,
        _gpuVersion: 0,
        _dirtyMin: 0,
        _dirtyMax: count,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: true,
    };
}

function makeBatchBinding(batch: DrawUpdateBatch): DrawBinding {
    const binding: DrawBinding = {
        renderable: { order: 100, isTransparent: false, bind: () => binding },
        pipeline: {} as GPURenderPipeline,
        draw: () => 0,
        _updateBatches: [batch],
    };
    return binding;
}

describe("thin-instance GPU culling submission", () => {
    it("recreates a retired compute batch before its fence without losing the replacement", async () => {
        let finishFence!: () => void;
        const fence = new Promise<void>((resolve) => {
            finishFence = resolve;
        });
        const dispatchWorkgroups = vi.fn();
        const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups, end: vi.fn() };
        const engine = {
            _device: { queue: { onSubmittedWorkDone: vi.fn(() => fence) } },
            _currentEncoder: { beginComputePass: vi.fn(() => pass) },
        } as unknown as EngineContext;
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        const first = getComputeDispatchBatch(signature);
        const destroyFirst = vi.spyOn(first, "destroy");
        const collector = signature._collectBatches!;
        const firstState = collector(undefined, makeBatchBinding(first))!;

        firstState._release(engine);
        expect(first._retired).toBe(true);
        expect(destroyFirst).not.toHaveBeenCalled();
        engine._flushGpuRetirements!(engine);
        await Promise.resolve();

        const second = getComputeDispatchBatch(signature);
        expect(second).not.toBe(first);
        second.queue({ pipeline: {} as GPUComputePipeline, bindGroup: {} as GPUBindGroup, workgroupsX: 3 });

        finishFence();
        await waitForGpuResourceRetirements(engine);
        expect(destroyFirst).toHaveBeenCalledOnce();
        first.destroy();
        expect(getComputeDispatchBatch(signature)).toBe(second);
        expect(signature._collectBatches).toBe(collector);
        second.flush(engine);
        expect(dispatchWorkgroups).toHaveBeenCalledExactlyOnceWith(3);
        second.destroy();
    });

    it("keeps shared compute batches active until the final batch state is released", () => {
        const engine = {} as EngineContext;
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        const first = getComputeDispatchBatch(signature);
        const destroyFirst = vi.spyOn(first, "destroy");
        const binding = makeBatchBinding(first);
        const original = signature._collectBatches!(undefined, binding)!;
        const retained = signature._collectBatches!(undefined, binding)!;

        original._release(engine, [retained]);
        expect(first._retired).toBe(false);
        expect(destroyFirst).not.toHaveBeenCalled();
        expect(engine._retirements).toBeUndefined();
        expect(getComputeDispatchBatch(signature)).toBe(first);

        retained._release();
        expect(destroyFirst).toHaveBeenCalledOnce();
        expect(first._retired).toBe(true);
        const second = getComputeDispatchBatch(signature);
        expect(second).not.toBe(first);
        first.destroy();
        expect(getComputeDispatchBatch(signature)).toBe(second);
        second.destroy();
    });

    it("registers cached culling state with the renderable lifetime rather than a transient bind generation", () => {
        const mesh = { thinInstances: makeThinInstances(1) } as Mesh;
        const bindingDisposers: (() => void)[] = [];
        const lifetimeDisposers: (() => void)[] = [];
        const scene = { _meshDisposables: new Map([[mesh, bindingDisposers]]) } as unknown as SceneContext;
        const renderable = { _lifetimeDisposers: lifetimeDisposers } as Renderable;
        const signature = {} as RenderTargetSignature;
        const engine = {} as EngineContext;
        expect(tryBind(renderable, scene, mesh, engine, false, false, undefined, signature)).toBeDefined();
        expect(tryBind(renderable, scene, mesh, engine, false, false, undefined, signature)).toBeDefined();
        expect(bindingDisposers).toHaveLength(0);
        expect(lifetimeDisposers).toHaveLength(1);
        lifetimeDisposers[0]!();
    });

    it.each([false, true])("queues dispatches and refreshes culling after a geometry update (ranged: %s)", (ranged) => {
        const buffers: (GPUBuffer & { descriptor: GPUBufferDescriptor })[] = [];
        const writeBuffer = vi.fn();
        const clearBuffer = vi.fn();
        const setPipeline = vi.fn();
        const setBindGroup = vi.fn();
        const dispatchWorkgroups = vi.fn();
        const beginComputePass = vi.fn(
            () =>
                ({
                    setPipeline,
                    setBindGroup,
                    dispatchWorkgroups,
                    end: vi.fn(),
                }) as unknown as GPUComputePassEncoder
        );
        const pipeline = {
            getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        } as unknown as GPUComputePipeline;
        const device = {
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const buffer = { descriptor, size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer & { descriptor: GPUBufferDescriptor };
                buffers.push(buffer);
                return buffer;
            }),
            createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
            createComputePipeline: vi.fn(() => pipeline),
            createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
            queue: { writeBuffer },
        } as unknown as GPUDevice;
        const engine = {
            _device: device,
            _currentEncoder: { beginComputePass, clearBuffer } as unknown as GPUCommandEncoder,
        } as unknown as EngineContext;
        const ti = makeThinInstances(65);
        const positionBuffer = {} as GPUBuffer;
        const normalBuffer = {} as GPUBuffer;
        const uvBuffer = {} as GPUBuffer;
        const indexBuffer = {} as GPUBuffer;
        const mesh = {
            visible: true,
            worldMatrix: identity(),
            _cpuPositions: new Float32Array([-1, -1, -1, 1, 1, 1]),
            _cpuNormals: new Float32Array([0, 1, 0, 0, 1, 0]),
            _cpuIndices: new Uint32Array([0, 1, 0]),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
            thinInstances: ti,
        } as unknown as Mesh;
        const gpu = {
            positionBuffer,
            normalBuffer,
            uvBuffer,
            indexBuffer,
            indexCount: 3,
            indexFormat: "uint32",
            hasUv: false,
            hasUv2: false,
            hasTangent: false,
            hasColor: false,
        } satisfies MeshGPU;
        mesh._gpu = gpu;
        const context = {
            targetWidth: 800,
            targetHeight: 600,
            _camera: makeCamera(),
        } satisfies DrawUpdateContext;
        const state = createTiCullState();
        const signature = {} as RenderTargetSignature;
        const batch = getComputeDispatchBatch(signature);

        const first = prepareTiCull(engine, state, mesh, gpu, ti, false, context, batch);
        batch.reset();
        const expandedPositions = new Float32Array([-2, -2, -2, 2, 2, 2]);
        if (ranged) {
            updateMeshGeometryCapacity(
                engine,
                mesh,
                expandedPositions,
                new Float32Array([0, 1, 0, 0, 1, 0]),
                new Uint32Array([0, 1, 0]),
                undefined,
                undefined,
                undefined,
                undefined,
                1.25,
                {
                    vertices: [{ offset: 0, count: 2 }],
                    indices: [],
                }
            );
        } else {
            updateMeshGeometry(engine, mesh, expandedPositions, new Float32Array([0, 1, 0, 0, 1, 0]), new Uint32Array([0, 1, 0]));
        }
        const second = prepareTiCull(engine, state, mesh, gpu, ti, false, context, batch);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(state._localSphere[3]).toBeCloseTo(Math.sqrt(12));
        expect(beginComputePass).not.toHaveBeenCalled();
        batch.flush(engine);
        expect(beginComputePass).toHaveBeenCalledTimes(1);
        expect(setPipeline).toHaveBeenCalledWith(pipeline);
        expect(setBindGroup).toHaveBeenCalledWith(0, state._bindGroup);
        expect(dispatchWorkgroups).toHaveBeenCalledWith(2);
        expect(clearBuffer).toHaveBeenCalledTimes(1);
        expect(clearBuffer).toHaveBeenCalledWith(state._argsBuffer, 4, 4);
        expect(writeBuffer.mock.calls.filter((call) => call[0] === state._argsBuffer && call[4] === 20)).toHaveLength(1);
        expect(buffers.some((buffer) => (buffer.descriptor.usage & GPUBufferUsage.INDIRECT) !== 0)).toBe(true);
    });

    it("allocates and publishes a second compacted bucket for an LOD partner", () => {
        const buffers: (GPUBuffer & { descriptor: GPUBufferDescriptor })[] = [];
        const uploadedArgs = new Map<GPUBuffer, number[]>();
        const writeBuffer = vi.fn((buffer: GPUBuffer, _offset: number, data: ArrayBuffer, dataOffset: number, size: number) => {
            if (size === 20) {
                uploadedArgs.set(buffer, Array.from(new Uint32Array(data, dataOffset, 5)));
            }
        });
        const pipeline = {
            getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
        } as unknown as GPUComputePipeline;
        const device = {
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const buffer = { descriptor, size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer & { descriptor: GPUBufferDescriptor };
                buffers.push(buffer);
                return buffer;
            }),
            createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
            createComputePipeline: vi.fn(() => pipeline),
            createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
            queue: { writeBuffer },
        } as unknown as GPUDevice;
        const engine = {
            _device: device,
            _currentEncoder: {
                beginComputePass: () =>
                    ({
                        setPipeline() {},
                        setBindGroup() {},
                        dispatchWorkgroups() {},
                        end() {},
                    }) as unknown as GPUComputePassEncoder,
                clearBuffer: vi.fn(),
            } as unknown as GPUCommandEncoder,
        } as unknown as EngineContext;
        const ti = makeThinInstances(8);
        const mesh = {
            visible: true,
            worldMatrix: identity(),
            _cpuPositions: new Float32Array([-1, -1, -1, 1, 1, 1]),
            boundMin: [-1, -1, -1],
            boundMax: [1, 1, 1],
            thinInstances: ti,
        } as unknown as Mesh;
        const gpu = {
            positionBuffer: {} as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
            _baseVertex: 4,
            hasUv: false,
            hasUv2: false,
            hasTangent: false,
            hasColor: false,
        } satisfies MeshGPU;
        mesh._gpu = gpu;
        const lodMesh = { _gpu: { ...gpu, indexCount: 12, _baseVertex: 20 } } as unknown as Mesh;
        const state = createTiCullState();

        const result = prepareTiCull(engine, state, mesh, gpu, ti, false, { targetWidth: 800, targetHeight: 600, _camera: makeCamera() }, undefined, lodMesh);

        expect(result?.lodDrawBuffers?.matrixBuffer).toBe(state._lodMatrixBuffer);
        expect(result?.lodDrawBuffers?.colorBuffer).toBeNull();
        expect(result?.lodArgsBuffer).toBe(state._lodArgsBuffer);
        expect(state._paramsBuffer?.size).toBe(224);
        expect(buffers.filter((buffer) => (buffer.descriptor.usage & GPUBufferUsage.INDIRECT) !== 0)).toHaveLength(2);
        const lodArgsWrite = writeBuffer.mock.calls.find((call) => call[0] === state._lodArgsBuffer);
        expect(lodArgsWrite).toBeDefined();
        expect(uploadedArgs.get(state._lodArgsBuffer!)).toEqual([12, 0, 0, 20, 0]);
        const mainArgsWrite = writeBuffer.mock.calls.find((call) => call[0] === state._argsBuffer);
        expect(mainArgsWrite).toBeDefined();
        expect(uploadedArgs.get(state._argsBuffer!)).toEqual([3, 0, 0, 4, 0]);
    });
});

describe("storage-backed thin-instance analytic bounds", () => {
    function fixture() {
        const dispatch = vi.fn();
        const clearBuffer = vi.fn();
        const device = {
            limits: { maxBufferSize: 1024 * 1024 },
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const data = new ArrayBuffer(Number(descriptor.size));
                return { size: descriptor.size, getMappedRange: () => data, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
            }),
            createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
            createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline),
            createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        const engine = {
            _device: device,
            _currentEncoder: {
                clearBuffer,
                beginComputePass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: dispatch, end: vi.fn() }),
            },
        } as unknown as EngineContext;
        const storage = createStorageBuffer(engine, 1024, { vertex: true, writable: true });
        const mesh = createMeshFromStorageBuffer(engine, "analytic", {
            storage,
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 8,
            arrayStride: 16,
            baseVertex: 4,
            boundMin: [-2, -4, -6],
            boundMax: [4, 8, 10],
        });
        mesh.thinInstances = makeThinInstances(8);
        const lod = createMeshFromStorageBuffer(engine, "analytic-lod", {
            storage,
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 8,
            arrayStride: 16,
            baseVertex: 20,
        });
        const state = createTiCullState();
        const context = { targetWidth: 800, targetHeight: 600, _camera: makeCamera() };
        const run = () => prepareTiCull(engine, state, mesh, mesh._gpu, mesh.thinInstances!, false, context, undefined, lod);
        return { engine, mesh, state, run, dispatch, clearBuffer };
    }

    it("dispatches culling and produces both LOD buckets without CPU positions", () => {
        const f = fixture();
        expect(f.mesh._cpuPositions).toBeUndefined();
        const result = f.run();
        expect(result).not.toBeNull();
        expect(result!.lodArgsBuffer).toBe(f.state._lodArgsBuffer);
        expect(result!.lodDrawBuffers?.matrixBuffer).toBe(f.state._lodMatrixBuffer);
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(Array.from(f.state._localSphere.subarray(0, 3))).toEqual([1, 2, 2]);
        expect(f.state._localSphere[3]).toBeCloseTo(Math.hypot(3, 6, 8));
    });

    it("caches unchanged bounds and picks up in-place edits without new snapshot allocations", () => {
        const f = fixture();
        f.run();
        const cachedMin = f.state._localBoundMin;
        const cachedMax = f.state._localBoundMax;
        f.run();
        expect(f.state._localBoundMin).toBe(cachedMin);
        expect(f.state._localBoundMax).toBe(cachedMax);
        f.mesh.boundMin![0] = -10;
        f.run();
        expect(f.state._localSphere[0]).toBe(-3);
        expect(f.state._localSphere[3]).toBeCloseTo(Math.hypot(7, 6, 8));
        expect(f.state._localBoundMin).toBe(cachedMin);
    });

    it("falls back for unusable bounds, clears the far bucket, and resumes after valid bounds return", () => {
        const f = fixture();
        f.run();
        f.mesh.boundMin![0] = f.mesh.boundMax![0] = 1e39;
        expect(f.run()).toBeNull();
        expect(f.clearBuffer).toHaveBeenCalledWith(f.state._lodArgsBuffer, 4, 4);
        expect(f.state._localSphereReady).toBe(false);
        f.mesh.boundMin![0] = -2;
        f.mesh.boundMax![0] = 4;
        expect(f.run()).not.toBeNull();
        expect(f.state._localSphere[0]).toBe(1);
        f.mesh.boundMin = undefined;
        expect(f.run()).toBeNull();
        f.mesh.boundMin = [10, 0, 0];
        f.mesh.boundMax = [0, 0, 0];
        expect(f.run()).toBeNull();
        f.mesh.boundMin = [NaN, 0, 0];
        expect(f.run()).toBeNull();
        f.mesh.boundMin = [0, 0, 0];
        expect(f.run()).not.toBeNull();
        expect(f.state._localSphere[3]).toBe(0);
    });
});

describe("thin-instance LOD cull binding", () => {
    it("reads the current bucket at draw time and falls back after the pairing is cleared", () => {
        const source = { thinInstances: makeThinInstances(2) } as unknown as Mesh;
        const partner = { thinInstances: makeThinInstances(2) } as unknown as Mesh;
        setThinInstanceLodPartner(source, partner, { distance: 10 });
        const signature = {} as RenderTargetSignature;
        const scene = { _meshDisposables: new Map([[partner, []]]) } as unknown as SceneContext;
        const renderable = {} as Renderable;
        const binding = tryBind(renderable, scene, partner, {} as EngineContext, false, false, undefined, signature)!;

        expect(renderable._direct).toBe(true);
        binding.update({ targetWidth: 1, targetHeight: 1 });
        expect(binding.cullDrawBufs).toBeNull();

        const matrixBuffer = {} as GPUBuffer;
        const argsBuffer = {} as GPUBuffer;
        publishTiLodBucket(source.thinInstances!, signature, {
            drawBuffers: { matrixBuffer: {} as GPUBuffer, colorBuffer: null },
            argsBuffer: {} as GPUBuffer,
            lodDrawBuffers: { matrixBuffer, colorBuffer: null },
            lodArgsBuffer: argsBuffer,
        });

        expect(binding.cullDrawBufs).toMatchObject({ matrixBuffer, colorBuffer: null });
        const culledPass = { drawIndexedIndirect: vi.fn(), drawIndexed: vi.fn() };
        const gpu = { indexCount: 36, _baseVertex: 8 } as unknown as MeshGPU;
        binding.draw(culledPass as unknown as GPURenderPassEncoder, gpu, 2);
        expect(culledPass.drawIndexedIndirect).toHaveBeenCalledWith(argsBuffer, 0);

        clearThinInstanceLodPartner(source);
        const fallbackPass = { drawIndexedIndirect: vi.fn(), drawIndexed: vi.fn() };
        binding.draw(fallbackPass as unknown as GPURenderPassEncoder, gpu, 2);
        expect(fallbackPass.drawIndexed).toHaveBeenCalledWith(36, 2, 0, 8);
    });

    it("rejects transparent partners and missing compacted color data", () => {
        const source = { thinInstances: makeThinInstances(1) } as unknown as Mesh;
        const partner = { thinInstances: makeThinInstances(1) } as unknown as Mesh;
        source.thinInstances!.colors = new Float32Array(4);
        partner.thinInstances!.colors = new Float32Array(4);
        setThinInstanceLodPartner(source, partner, { distance: 10 });
        const signature = {} as RenderTargetSignature;
        const scene = { _meshDisposables: new Map([[partner, []]]) } as unknown as SceneContext;

        expect(() => tryBind({} as Renderable, scene, partner, {} as EngineContext, false, true, undefined, signature)).toThrow("opaque");

        const binding = tryBind({} as Renderable, scene, partner, {} as EngineContext, true, false, undefined, signature)!;
        publishTiLodBucket(source.thinInstances!, signature, {
            drawBuffers: { matrixBuffer: {} as GPUBuffer, colorBuffer: null },
            argsBuffer: {} as GPUBuffer,
            lodDrawBuffers: { matrixBuffer: {} as GPUBuffer, colorBuffer: null },
            lodArgsBuffer: {} as GPUBuffer,
        });
        expect(() => binding.cullDrawBufs).toThrow("provide instance colors");
    });

    it("reuses source cull-state disposal and does not add partner cleanup callbacks on rebind", () => {
        const source = { thinInstances: makeThinInstances(1) } as unknown as Mesh;
        const partner = { thinInstances: makeThinInstances(1) } as unknown as Mesh;
        source._gpu = { indexCount: 3 } as MeshGPU;
        setThinInstanceLodPartner(source, partner, { distance: 10 });
        const sourceDisposers: Array<() => void> = [];
        const partnerDisposers: Array<() => void> = [];
        const scene = {
            _meshDisposables: new Map([
                [source, sourceDisposers],
                [partner, partnerDisposers],
            ]),
        } as unknown as SceneContext;
        const signature = {} as RenderTargetSignature;
        const sourceRenderable = {} as Renderable;

        expect(tryBind(sourceRenderable, scene, source, {} as EngineContext, false, false, undefined, signature)).toBeDefined();
        expect(tryBind(sourceRenderable, scene, source, {} as EngineContext, false, false, undefined, signature)).toBeDefined();
        expect(sourceDisposers).toHaveLength(1);

        expect(tryBind({} as Renderable, scene, partner, {} as EngineContext, false, false, undefined, signature)).toBeDefined();
        expect(tryBind({} as Renderable, scene, partner, {} as EngineContext, false, false, undefined, signature)).toBeDefined();
        expect(partnerDisposers).toHaveLength(0);
    });
});
