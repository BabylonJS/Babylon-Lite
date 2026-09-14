import { describe, expect, it, vi } from "vitest";

import { BU } from "../../../packages/babylon-lite/src/engine/gpu-flags.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { _rebuildStorageBuffers, createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer.js";

/** Build an engine whose `device.createBuffer` records every descriptor it was given,
 *  so a test can compare the usage flags used on first creation against the flags used
 *  to rebuild the same allocation after a device-loss recovery. */
function makeEngine(): { engine: EngineContext; descriptors: GPUBufferDescriptor[] } {
    const descriptors: GPUBufferDescriptor[] = [];
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            descriptors.push(descriptor);
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return {
                size: descriptor.size,
                destroy: vi.fn(),
                getMappedRange: () => mapped,
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn() },
        limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512, maxStorageBuffersPerShaderStage: 8 },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, descriptors };
}

describe("_rebuildStorageBuffers usage flags", () => {
    it.each([
        { label: "plain read-only", options: undefined, expected: BU.STORAGE },
        { label: "vertex-sourced", options: { vertex: true }, expected: BU.STORAGE | BU.VERTEX },
        { label: "shared index topology", options: { index: true }, expected: BU.STORAGE | BU.INDEX },
        { label: "writable/compute target", options: { writable: true }, expected: BU.STORAGE | BU.COPY_SRC },
        {
            label: "vertex + index + writable combined",
            options: { vertex: true, index: true, writable: true },
            expected: BU.STORAGE | BU.VERTEX | BU.INDEX | BU.COPY_SRC,
        },
    ])("preserves usage for a $label allocation across rebuild", ({ options, expected }) => {
        const { engine, descriptors } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(4), options);
        const initialUsage = descriptors.at(-1)!.usage;
        // COPY_DST is always appended by the underlying buffer-creation helpers on top of
        // the caller-declared usage — assert on the declared bits, not the raw descriptor.
        expect(initialUsage & ~BU.COPY_DST).toBe(expected);

        descriptors.length = 0;
        _rebuildStorageBuffers(engine);

        expect(descriptors).toHaveLength(1);
        expect(descriptors[0]!.usage & ~BU.COPY_DST).toBe(expected);
        expect(descriptors[0]!.usage).toBe(initialUsage);
        expect(storage._buffer).not.toBeNull();
    });

    it("leaves disposed and destroyed allocations out of a rebuild", () => {
        const { engine, descriptors } = makeEngine();
        const storage = createStorageBuffer(engine, new Float32Array(4), { index: true });
        storage._destroyed = true;

        descriptors.length = 0;
        _rebuildStorageBuffers(engine);

        expect(descriptors).toHaveLength(0);
    });
});
