import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createShaderMaterial, setShaderStorageBuffer } from "../../../packages/babylon-lite/src/material/shader/shader-material.js";
import { _rebuildStorageBuffers, createStorageBuffer, disposeStorageBuffer, updateStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { STORAGE: number; COPY_DST: number };
};
gpuGlobals.GPUBufferUsage ??= { STORAGE: 0x80, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

function makeEngine() {
    const rawBuffer = {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => new ArrayBuffer(16)),
        unmap: vi.fn(),
    };
    const device = {
        createBuffer: vi.fn(() => rawBuffer),
        queue: { writeBuffer: vi.fn() },
    };
    return { engine: { _device: device } as unknown as EngineContext, device, rawBuffer };
}

describe("StorageBuffer", () => {
    it("creates an initialized storage allocation without exposing it as the public value", () => {
        const { engine, device, rawBuffer } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array([1, 2, 3]), "cells");

        expect(storage.byteLength).toBe(12);
        expect(storage).not.toBe(rawBuffer);
        expect(storage._buffer).toBe(rawBuffer);
        expect(device.createBuffer).toHaveBeenCalledWith({
            label: "cells",
            size: 12,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        expect(rawBuffer.unmap).toHaveBeenCalledOnce();
    });

    it("updates aligned in-bounds ranges and rejects invalid writes", () => {
        const { engine, device } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(4));
        const update = new Float32Array([4, 5]);

        updateStorageBuffer(engine, storage, update, 4);
        expect(device.queue.writeBuffer).toHaveBeenCalledWith(storage._buffer, 4, update.buffer, update.byteOffset, update.byteLength);
        device.queue.writeBuffer.mockClear();
        updateStorageBuffer(engine, storage, new Uint8Array(0), storage.byteLength);
        expect(device.queue.writeBuffer).not.toHaveBeenCalled();
        expect(() => updateStorageBuffer(engine, storage, update, 12)).toThrow(/exceeds/);
        expect(() => updateStorageBuffer(engine, storage, new Uint8Array(3))).toThrow(/multiple of 4/);
        expect(() => updateStorageBuffer(makeEngine().engine, storage, update)).toThrow(/different engine/);
    });

    it("disposes idempotently and rejects later updates", () => {
        const { engine, rawBuffer } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(1));

        disposeStorageBuffer(storage);
        disposeStorageBuffer(storage);
        expect(rawBuffer.destroy).toHaveBeenCalledOnce();
        expect(() => updateStorageBuffer(engine, storage, new Float32Array(1))).toThrow(/disposed/);
    });

    it("binds through ShaderMaterial identity and rejects disposed resources", () => {
        const { engine } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(4));
        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
            fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
            attributes: ["position"],
            storageBuffers: [{ name: "cells", type: "array<f32>" }],
        });

        setShaderStorageBuffer(material, "cells", storage);
        const version = material._resourceVersion;
        expect(material._storageBufferSlots.get("cells")!.current).toBe(storage);

        setShaderStorageBuffer(material, "cells", storage);
        expect(material._resourceVersion).toBe(version);

        disposeStorageBuffer(storage);
        expect(() => setShaderStorageBuffer(material, "cells", storage)).toThrow(/disposed/);
        setShaderStorageBuffer(material, "cells", null);
        expect(material._storageBufferSlots.get("cells")!.current).toBeNull();
    });

    it("rejects raw GPUBuffer values with a clear migration error", () => {
        const { rawBuffer } = makeEngine();
        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
            fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
            attributes: ["position"],
            storageBuffers: [{ name: "cells", type: "array<f32>" }],
        });

        expect(() => setShaderStorageBuffer(material, "cells", rawBuffer as unknown as StorageBuffer)).toThrow(
            "setShaderStorageBuffer requires a StorageBuffer created by createStorageBuffer; raw GPUBuffer is not supported."
        );
        expect(material._storageBufferSlots.get("cells")!.current).toBeNull();
    });

    it("rebuilds its GPU handle from retained bytes after a device change", () => {
        const firstMapped = new ArrayBuffer(8);
        const firstBuffer = { destroy: vi.fn(), getMappedRange: () => firstMapped, unmap: vi.fn() } as unknown as GPUBuffer;
        const secondMapped = new ArrayBuffer(8);
        const secondBuffer = { destroy: vi.fn(), getMappedRange: () => secondMapped, unmap: vi.fn() } as unknown as GPUBuffer;
        const engine = {
            _device: {
                createBuffer: vi.fn(() => firstBuffer),
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const storage = createStorageBuffer(engine, new Float32Array([1, 2]));
        updateStorageBuffer(engine, storage, new Float32Array([9]), 4);

        engine._device = {
            createBuffer: vi.fn(() => secondBuffer),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        _rebuildStorageBuffers(engine);

        expect(storage._buffer).toBe(secondBuffer);
        expect(Array.from(new Float32Array(secondMapped))).toEqual([1, 9]);
    });

    it("is nominally branded", () => {
        // @ts-expect-error Plain public-shape objects must not satisfy the opaque handle type.
        const forged: StorageBuffer = { byteLength: 4 };
        expect(forged.byteLength).toBe(4);
    });
});
