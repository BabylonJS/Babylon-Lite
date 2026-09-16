import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createShaderMaterial, setShaderStorageBuffer } from "../../../packages/babylon-lite/src/material/shader/shader-material.js";
import {
    _rebuildStorageBuffers,
    createStorageBuffer,
    disposeStorageBuffer,
    readStorageBuffer,
    updateStorageBuffer,
} from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";
import { align } from "../../../packages/babylon-lite/src/resource/gpu-buffers.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUMapMode"> & {
    GPUBufferUsage?: { STORAGE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
    GPUMapMode?: { READ: number };
};
gpuGlobals.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1 } as unknown as GPUBufferUsage;
Object.assign(gpuGlobals.GPUBufferUsage, { COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1, STORAGE: 0x80 });
gpuGlobals.GPUMapMode ??= { READ: 0x1 } as unknown as GPUMapMode;

function makeEngine(maxBufferSize = 256 * 1024 * 1024) {
    const mapped = new ArrayBuffer(16);
    const rawBuffer = {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => mapped),
        unmap: vi.fn(),
    };
    const device = {
        limits: { maxBufferSize },
        createBuffer: vi.fn(() => rawBuffer),
        queue: { writeBuffer: vi.fn() },
    };
    return { engine: { _device: device } as unknown as EngineContext, device, rawBuffer };
}

describe("StorageBuffer", () => {
    it.each([0, 1, 3, 5, 8])("initializes %s writable bytes through an aligned mapped allocation without a CPU shadow", (length) => {
        const { engine, device, rawBuffer } = makeEngine();
        const source = new Uint8Array(12).fill(99);
        for (let index = 0; index < length; index++) {
            source[index + 2] = index + 1;
        }
        const view = source.subarray(2, length + 2);
        const storage = createStorageBuffer(engine, view, { writable: true });
        const capacity = Math.ceil(Math.max(length, 4) / 4) * 4;
        expect(storage.byteLength).toBe(capacity);
        expect(storage._data).toBeNull();
        expect(device.queue.writeBuffer).not.toHaveBeenCalled();
        expect(device.createBuffer).toHaveBeenCalledWith(
            expect.objectContaining({
                size: capacity,
                mappedAtCreation: true,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            })
        );
        expect(Array.from(new Uint8Array(rawBuffer.getMappedRange(), 0, capacity))).toEqual(Array.from({ length: capacity }, (_, index) => (index < length ? index + 1 : 0)));
        expect(rawBuffer.unmap).toHaveBeenCalledOnce();
        expect(new Uint8Array(source.buffer)[0]).toBe(99);
    });

    it.each([-1, -0.5, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric size %s before allocation", (size) => {
        const { engine, device } = makeEngine();
        for (const writable of [false, true]) {
            expect(() => createStorageBuffer(engine, size, { writable })).toThrow(/byte length must be a non-negative safe integer/);
        }
        expect(device.createBuffer).not.toHaveBeenCalled();
        expect(device.queue.writeBuffer).not.toHaveBeenCalled();
        expect(engine._storageBuffers).toBeUndefined();
        expect(engine._storageRequiredLimits).toBeUndefined();
    });

    it.each([
        [0, 4],
        [1, 4],
        [3, 4],
        [4, 4],
        [5, 8],
        [15, 16],
        [16, 16],
    ])("pads valid size %s to %s bytes", (size, expected) => {
        for (const writable of [false, true]) {
            const { engine, device } = makeEngine(16);
            const storage = createStorageBuffer(engine, size, { writable });
            expect(storage.byteLength).toBe(expected);
            expect(device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: expected }));
            expect(storage._data?.byteLength ?? null).toBe(writable ? null : expected);
        }
    });

    it.each([
        [16, 17],
        [15, 13],
        [3, 0],
    ])("rejects size %s/%s when its padded capacity exceeds maxBufferSize", (limit, size) => {
        const { engine, device } = makeEngine(limit);
        for (const writable of [false, true]) {
            expect(() => createStorageBuffer(engine, size, { writable })).toThrow(new RegExp(`maxBufferSize \\(${limit}\\)`));
        }
        expect(device.createBuffer).not.toHaveBeenCalled();
        expect(engine._storageBuffers).toBeUndefined();
    });

    it("rejects padding beyond the safe-integer range even when the mocked GPU limit allows it", () => {
        const { engine, device } = makeEngine(2 ** 53);
        expect(() => createStorageBuffer(engine, Number.MAX_SAFE_INTEGER, { writable: true })).toThrow(/aligned byte length .*safe integer/);
        expect(device.createBuffer).not.toHaveBeenCalled();
    });

    it.each([
        [0x7ffffffd, 0x80000000],
        [0x80000000, 0x80000000],
        [0x80000001, 0x80000004],
        [0xfffffffd, 0x100000000],
        [0x100000000, 0x100000000],
        [0x100000001, 0x100000004],
        [Number.MAX_SAFE_INTEGER - 3, Number.MAX_SAFE_INTEGER - 3],
    ])("preserves large size %s as %s without a CPU shadow or 32-bit wrapping", (size, expected) => {
        const { engine, device, rawBuffer } = makeEngine(expected);
        const storage = createStorageBuffer(engine, size, { writable: true });
        expect(storage.byteLength).toBe(expected);
        expect(device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: expected }));
        expect(storage._data).toBeNull();
        expect(rawBuffer.getMappedRange).not.toHaveBeenCalled();
    });

    it("validates typed-view capacity after padding and copies only the selected bytes", () => {
        const { engine, device, rawBuffer } = makeEngine(4);
        const source = new Uint8Array([99, 1, 2, 3, 99, 99]);
        const storage = createStorageBuffer(engine, source.subarray(1, 4));
        expect(storage.byteLength).toBe(4);
        expect(Array.from(new Uint8Array(rawBuffer.getMappedRange(), 0, 4))).toEqual([1, 2, 3, 0]);
        device.createBuffer.mockClear();
        expect(() => createStorageBuffer(engine, source)).toThrow(/maxBufferSize/);
        expect(device.createBuffer).not.toHaveBeenCalled();
        const small = makeEngine(3);
        expect(() => createStorageBuffer(small.engine, source.subarray(1, 4))).toThrow(/maxBufferSize/);
        expect(small.device.createBuffer).not.toHaveBeenCalled();
    });

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

    it("reads writable GPU output through one reused staging allocation", async () => {
        const source = { destroy: vi.fn() } as unknown as GPUBuffer;
        const mapped = new Float32Array([1, 2, 3, 4]);
        const staging = {
            destroy: vi.fn(),
            mapAsync: vi.fn(async () => undefined),
            getMappedRange: vi.fn(() => mapped.buffer),
            unmap: vi.fn(),
        } as unknown as GPUBuffer;
        const copyBufferToBuffer = vi.fn();
        const submit = vi.fn();
        const device = {
            limits: { maxBufferSize: 256 * 1024 * 1024 },
            createBuffer: vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(staging),
            createCommandEncoder: vi.fn(() => ({ copyBufferToBuffer, finish: vi.fn(() => ({})) })),
            queue: { writeBuffer: vi.fn(), submit },
        } as unknown as GPUDevice;
        const engine = { _device: device } as unknown as EngineContext;
        const storage = createStorageBuffer(engine, 16, { writable: true, label: "probe" });

        engine._currentEncoder = {} as GPUCommandEncoder;
        await expect(readStorageBuffer(storage)).rejects.toThrow(/frame encoder is active/);
        expect(device.createBuffer).toHaveBeenCalledTimes(1);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(storage._readback).toBeUndefined();
        engine._currentEncoder = null!;
        expect(Array.from(new Float32Array(await readStorageBuffer(storage)))).toEqual([1, 2, 3, 4]);
        expect(copyBufferToBuffer).toHaveBeenCalledWith(source, 0, staging, 0, 16);
        expect(submit).toHaveBeenCalledOnce();

        await readStorageBuffer(storage);
        expect(device.createBuffer).toHaveBeenCalledTimes(2);
        disposeStorageBuffer(storage);
        expect(staging.destroy).toHaveBeenCalledOnce();
    });

    it("does not reuse an older pending readback for a call made during frame recording", async () => {
        const { engine } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        const olderReadback = Promise.resolve(new ArrayBuffer(16));
        storage._readPending = olderReadback;
        engine._currentEncoder = {} as GPUCommandEncoder;
        await expect(readStorageBuffer(storage)).rejects.toThrow(/frame encoder is active/);
        expect(storage._readPending).toBe(olderReadback);
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
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
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
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
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
                limits: { maxBufferSize: 256 * 1024 * 1024 },
                createBuffer: vi.fn(() => firstBuffer),
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const storage = createStorageBuffer(engine, new Float32Array([1, 2]));
        updateStorageBuffer(engine, storage, new Float32Array([9]), 4);

        engine._device = {
            limits: { maxBufferSize: 256 * 1024 * 1024 },
            createBuffer: vi.fn(() => secondBuffer),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        _rebuildStorageBuffers(engine);

        expect(storage._buffer).toBe(secondBuffer);
        expect(Array.from(new Float32Array(secondMapped))).toEqual([1, 9]);
    });

    describe("GPU buffer alignment", () => {
        it.each([
            [0, 4, 0],
            [1, 4, 4],
            [16, 16, 16],
            [17, 16, 32],
            [257, 256, 512],
            [0x7ffffffd, 4, 0x80000000],
            [0x80000001, 256, 0x80000100],
            [0xffffffff, 4, 0x100000000],
            [0x100000001, 16, 0x100000010],
        ])("aligns %s to %s without bitwise truncation", (size, alignment, expected) => {
            expect(align(size, alignment)).toBe(expected);
        });
    });

    it("is nominally branded", () => {
        // @ts-expect-error Plain public-shape objects must not satisfy the opaque handle type.
        const forged: StorageBuffer = { byteLength: 4 };
        expect(forged.byteLength).toBe(4);
    });
});
