import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createShaderMaterial, setShaderStorageBuffer } from "../../../packages/babylon-lite/src/material/shader/shader-material.js";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { _getStorageBufferHandle, createStorageBuffer, disposeStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import { updateStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { STORAGE: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
};
gpuGlobals.GPUBufferUsage ??= { STORAGE: 0x80, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 } as unknown as GPUShaderStage;

function makeEngine(): { engine: EngineContext; rawBuffer: GPUBuffer & { destroy: ReturnType<typeof vi.fn> }; deviceDestroy: ReturnType<typeof vi.fn> } {
    const rawBuffer = {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => new ArrayBuffer(16)),
        unmap: vi.fn(),
    } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
    const deviceDestroy = vi.fn();
    const surface = {
        _renderingContexts: [],
        _context: { unconfigure: vi.fn() },
    };
    const engine = {
        _device: {
            createBuffer: vi.fn(() => rawBuffer),
            queue: { writeBuffer: vi.fn() },
            destroy: deviceDestroy,
            limits: {
                maxBufferSize: 1024,
                maxStorageBufferBindingSize: 512,
                maxStorageBuffersPerShaderStage: 8,
            },
        },
        _surfaces: [surface],
        surfaces: [surface],
        _retirements: [],
        _renderFn: null,
        _animFrameId: 0,
    } as unknown as EngineContext;
    return { engine, rawBuffer, deviceDestroy };
}

function makeRenderableFixture() {
    const buffers: GPUBuffer[] = [];
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            const buffer = {
                size: descriptor.size,
                destroy: vi.fn(),
                getMappedRange: () => mapped,
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup,
        queue: { writeBuffer: vi.fn() },
        limits: {
            maxBufferSize: 1024,
            maxStorageBufferBindingSize: 512,
            maxStorageBuffersPerShaderStage: 8,
        },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 1, height: 1 },
    } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
        attributes: ["position"],
        storageBuffers: [{ name: "cells", type: "array<f32>" }],
    });
    const mesh = {
        name: "storage",
        children: [],
        material,
        receiveShadows: false,
        _gpu: {
            positionBuffer: {} as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
        },
    } as unknown as Mesh;
    initMeshTransform(mesh);
    const scene = {
        surface: { engine },
        camera: null,
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
    } as unknown as SceneContext;
    return { buffers, createBindGroup, device, engine, material, mesh, scene };
}

describe("StorageBuffer lifecycle", () => {
    it("rejects binding through a different engine", () => {
        const first = makeEngine();
        const second = makeEngine();
        const storage = createStorageBuffer(first.engine, new Float32Array(1));

        expect(() => _getStorageBufferHandle(second.engine, storage)).toThrow("different engine");
    });

    it("disposes live storage allocations with the engine", () => {
        const { engine, rawBuffer, deviceDestroy } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(1));

        disposeEngine(engine);

        expect(rawBuffer.destroy).toHaveBeenCalledOnce();
        expect(deviceDestroy).toHaveBeenCalledOnce();
        expect(storage._destroyed).toBe(true);
        expect(storage._data).toBeNull();
        expect(engine._storageBuffers).toBeUndefined();
        expect(engine._storageRequiredLimits).toBeUndefined();
    });

    it("builds ShaderMaterial bind groups with the live recovered handle", () => {
        const fixture = makeRenderableFixture();
        const storage = createStorageBuffer(fixture.engine, new Float32Array(4));
        const initialHandle = storage._buffer;
        expect(fixture.engine._storageRequiredLimits).toEqual({
            maxBufferSize: 1024,
            maxStorageBufferBindingSize: 512,
            maxStorageBuffersPerShaderStage: 8,
        });
        setShaderStorageBuffer(fixture.material, "cells", storage);

        buildShaderMaterialRenderables(fixture.scene, [fixture.mesh]);
        const initialDescriptor = fixture.createBindGroup.mock.calls.at(-1)![0];
        expect((Array.from(initialDescriptor.entries).at(-1)!.resource as GPUBufferBinding).buffer).toBe(initialHandle);

        const replacement = makeRenderableFixture();
        fixture.engine._device = replacement.device;
        fixture.engine._rebuildStorageBuffers!();
        buildShaderMaterialRenderables(fixture.scene, [fixture.mesh]);
        const recoveredDescriptor = replacement.createBindGroup.mock.calls.at(-1)![0];
        expect((Array.from(recoveredDescriptor.entries).at(-1)!.resource as GPUBufferBinding).buffer).toBe(storage._buffer);
        expect(storage._buffer).not.toBe(initialHandle);
    });

    it("rejects wrong-engine and disposed resources through the render path", () => {
        const owner = makeRenderableFixture();
        const other = makeRenderableFixture();
        const storage = createStorageBuffer(owner.engine, new Float32Array(4));
        setShaderStorageBuffer(other.material, "cells", storage);

        expect(() => buildShaderMaterialRenderables(other.scene, [other.mesh])).toThrow("is invalid");

        setShaderStorageBuffer(owner.material, "cells", storage);
        disposeStorageBuffer(storage);
        expect(() => buildShaderMaterialRenderables(owner.scene, [owner.mesh])).toThrow("is invalid");
    });

    it("does not allow shallow copies to impersonate registered storage", () => {
        const { engine, rawBuffer } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(1));
        const copy: StorageBuffer = { ...storage };

        expect(Object.keys(storage)).toEqual(["byteLength"]);
        expect(() => updateStorageBuffer(engine, copy, new Float32Array(1))).toThrow("live registered allocation");
        expect(() => disposeStorageBuffer(copy)).toThrow("live registered allocation");
        expect(rawBuffer.destroy).not.toHaveBeenCalled();
        expect(engine._storageBuffers?.has(storage)).toBe(true);
    });

    it("rejects an unregistered wrapper through the production bind path", () => {
        const fixture = makeRenderableFixture();
        const storage = createStorageBuffer(fixture.engine, new Float32Array(1));
        setShaderStorageBuffer(fixture.material, "cells", storage);
        fixture.engine._storageBuffers!.delete(storage);

        expect(() => buildShaderMaterialRenderables(fixture.scene, [fixture.mesh])).toThrow("is invalid");
    });
});
