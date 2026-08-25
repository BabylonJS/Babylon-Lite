import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { tryBind } from "../../../packages/babylon-lite/src/mesh/thin-instance-cull-binding";
import { createTiCullState, getComputeDispatchBatch, prepareTiCull, publishTiLodBucket } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling";
import { clearThinInstanceLodPartner, setThinInstanceLodPartner, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { DrawUpdateContext, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
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

describe("thin-instance GPU culling submission", () => {
    it("queues dispatches and clears only the indirect instance count after initialization", () => {
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
        updateMeshGeometry(engine, mesh, expandedPositions, new Float32Array([0, 1, 0, 0, 1, 0]), new Uint32Array([0, 1, 0]));
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
        const writeBuffer = vi.fn();
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
            hasUv: false,
            hasUv2: false,
            hasTangent: false,
            hasColor: false,
        } satisfies MeshGPU;
        mesh._gpu = gpu;
        const lodMesh = { _gpu: { ...gpu, indexCount: 12 } } as unknown as Mesh;
        const state = createTiCullState();

        const result = prepareTiCull(engine, state, mesh, gpu, ti, false, { targetWidth: 800, targetHeight: 600, _camera: makeCamera() }, undefined, lodMesh);

        expect(result?.lodDrawBuffers?.matrixBuffer).toBe(state._lodMatrixBuffer);
        expect(result?.lodDrawBuffers?.colorBuffer).toBeNull();
        expect(result?.lodArgsBuffer).toBe(state._lodArgsBuffer);
        expect(state._paramsBuffer?.size).toBe(224);
        expect(buffers.filter((buffer) => (buffer.descriptor.usage & GPUBufferUsage.INDIRECT) !== 0)).toHaveLength(2);
        const lodArgsWrite = writeBuffer.mock.calls.find((call) => call[0] === state._lodArgsBuffer);
        expect(lodArgsWrite).toBeDefined();
        expect(Array.from(new Uint32Array(lodArgsWrite![2] as ArrayBuffer, lodArgsWrite![3] as number, 5))).toEqual([12, 0, 0, 0, 0]);
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
        binding.draw(culledPass as unknown as GPURenderPassEncoder, 36, 2);
        expect(culledPass.drawIndexedIndirect).toHaveBeenCalledWith(argsBuffer, 0);

        clearThinInstanceLodPartner(source);
        const fallbackPass = { drawIndexedIndirect: vi.fn(), drawIndexed: vi.fn() };
        binding.draw(fallbackPass as unknown as GPURenderPassEncoder, 36, 2);
        expect(fallbackPass.drawIndexed).toHaveBeenCalledWith(36, 2);
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
