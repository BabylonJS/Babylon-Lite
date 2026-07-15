import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { createTiCullState, getComputeDispatchBatch, prepareTiCull } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { DrawUpdateContext } from "../../../packages/babylon-lite/src/render/renderable";

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
});
