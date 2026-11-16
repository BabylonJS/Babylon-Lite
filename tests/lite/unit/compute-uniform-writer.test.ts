import { describe, expect, it, vi } from "vitest";

import {
    createComputeUniformLayout,
    createComputeUniformWriter,
    setComputeUniform,
    setComputeUniformF16,
    setComputeUniformF32,
    setComputeUniformI32,
    setComputeUniformMatrix,
    setComputeUniformU32,
    setComputeUniformVector,
} from "../../../packages/babylon-lite/src/compute/compute-uniform-writer";
import { createComputeUniformF16Writer } from "../../../packages/babylon-lite/src/compute/compute-uniform-f16";
import { createComputeTask } from "../../../packages/babylon-lite/src/compute/compute-task";
import { createComputeUniformArena } from "../../../packages/babylon-lite/src/compute/compute-uniform-arena";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: Record<string, number>;
};
gpuGlobals.GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 0x40 };

function makeEngine(features: GPUFeatureName[] = []): {
    engine: EngineContext;
    writes: [GPUBuffer, number, AllowSharedBufferSource, number | undefined, number | undefined][];
} {
    const writes: [GPUBuffer, number, AllowSharedBufferSource, number | undefined, number | undefined][] = [];
    const device = {
        features: new Set(features),
        limits: { minUniformBufferOffsetAlignment: 256, maxBufferSize: 256 * 1024 * 1024 },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return {
                descriptor,
                getMappedRange: () => mapped,
                unmap: vi.fn(),
                destroy: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        queue: {
            writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset?: number, size?: number) =>
                writes.push([buffer, offset, data, dataOffset, size])
            ),
        },
    } as unknown as GPUDevice;
    return { engine: { _device: device } as EngineContext, writes };
}

describe("typed compute uniform writers", () => {
    it("precomputes WGSL field offsets and rejects invalid layouts", () => {
        const layout = createComputeUniformLayout([
            { name: "first", type: "u32" },
            { name: "second", type: "i32" },
            { name: "amount", type: "f32" },
            { name: "direction", type: "vec3<f32>" },
            { name: "tag", type: "u32" },
            { name: "basis", type: "mat3x3<f32>" },
        ]);

        expect(layout.byteLength).toBe(80);
        expect([...layout._fields].map(([name, field]) => [name, field.offset, field.byteLength])).toEqual([
            ["first", 0, 4],
            ["second", 4, 4],
            ["amount", 8, 4],
            ["direction", 16, 12],
            ["tag", 28, 4],
            ["basis", 32, 48],
        ]);
        expect(() => createComputeUniformLayout([])).toThrow(/at least one field/);
        expect(() => createComputeUniformLayout([{ name: "", type: "f32" }])).toThrow(/must not be empty/);
        expect(() => createComputeUniformLayout([{ name: "réflexion", type: "f32" }])).not.toThrow();
        expect(() =>
            createComputeUniformLayout([
                { name: "value", type: "f32" },
                { name: "value", type: "u32" },
            ])
        ).toThrow(/duplicate field/);
        expect(() => createComputeUniformLayout([{ name: "value", type: "bool" as "f32" }])).toThrow(/unsupported field type/);
    });

    it("writes mixed scalar, vector, and matrix values directly into one arena slot", () => {
        const { engine, writes } = makeEngine();
        const task = createComputeTask(engine);
        const layout = createComputeUniformLayout([
            { name: "gain", type: "f32" },
            { name: "count", type: "u32" },
            { name: "delta", type: "i32" },
            { name: "direction", type: "vec3<f32>" },
            { name: "basis", type: "mat3x3<f32>" },
        ]);
        const arena = createComputeUniformArena(task, layout.byteLength, 2);
        const writer = createComputeUniformWriter(arena, 1, layout);
        const f32View = writer._f32;
        const u32View = writer._u32;
        const i32View = writer._i32;
        setComputeUniformF32(writer, "gain", 2.25);
        setComputeUniformU32(writer, "count", 0xffffffff);
        setComputeUniformI32(writer, "delta", -7);
        setComputeUniformVector(writer, "direction", new Float32Array([3, 4, 5]));
        setComputeUniformMatrix(writer, "basis", new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

        const base = arena.slotStride;
        expect(f32View[base / 4]).toBe(2.25);
        expect(u32View[(base + 4) / 4]).toBe(0xffffffff);
        expect(i32View[(base + 8) / 4]).toBe(-7);
        expect([...f32View.subarray((base + 16) / 4, (base + 28) / 4)]).toEqual([3, 4, 5]);
        expect([...f32View.subarray((base + 32) / 4, (base + 44) / 4)]).toEqual([1, 2, 3]);
        expect([...f32View.subarray((base + 48) / 4, (base + 60) / 4)]).toEqual([4, 5, 6]);
        expect([...f32View.subarray((base + 64) / 4, (base + 76) / 4)]).toEqual([7, 8, 9]);
        expect(writer._f32).toBe(f32View);

        task._flushOwned!();
        expect(writes).toHaveLength(1);
        expect(writes[0]![1]).toBe(base);
        expect(writes[0]![3]).toBe(base);
        expect(writes[0]![4]).toBe(layout.byteLength);
    });

    it("validates setter categories and exact element counts while retaining a generic convenience path", () => {
        const { engine } = makeEngine();
        const task = createComputeTask(engine);
        const layout = createComputeUniformLayout([
            { name: "value", type: "f32" },
            { name: "direction", type: "vec2<i32>" },
            { name: "matrix", type: "mat2x2<f32>" },
        ]);
        const arena = createComputeUniformArena(task, layout.byteLength, 1);
        const writer = createComputeUniformWriter(arena, 0, layout);

        expect(() => setComputeUniformU32(writer, "value", 1)).toThrow(/does not match/);
        expect(() => setComputeUniformVector(writer, "value", [1])).toThrow(/not supported/);
        expect(() => setComputeUniformVector(writer, "direction", [1])).toThrow(/expects 2 values/);
        expect(() => setComputeUniformMatrix(writer, "matrix", [1, 2, 3])).toThrow(/expects 4 values/);
        expect(() => setComputeUniform(writer, "direction", 1)).toThrow(/expects 2 values/);
        expect(() => setComputeUniform(writer, "missing", 1)).toThrow(/was not declared/);

        setComputeUniform(writer, "value", [6]);
        setComputeUniform(writer, "direction", [7, -8]);
        setComputeUniform(writer, "matrix", [1, 2, 3, 4]);

        expect(writer._f32[0]).toBe(6);
        expect([...writer._i32.subarray(2, 4)]).toEqual([7, -8]);
        expect([...writer._f32.subarray(4, 8)]).toEqual([1, 2, 3, 4]);
    });

    it("packs opt-in f16 scalar, vector, and matrix fields without per-write allocations", () => {
        const { engine } = makeEngine(["shader-f16"]);
        const task = createComputeTask(engine);
        const layout = createComputeUniformLayout([
            { name: "scalar", type: "f16" },
            { name: "vector", type: "vec2<f16>" },
            { name: "matrix", type: "mat2x2<f16>" },
        ]);
        const arena = createComputeUniformArena(task, layout.byteLength, 1);
        expect(() => createComputeUniformWriter(arena, 0, layout)).toThrow(/createComputeUniformF16Writer/);
        const writer = createComputeUniformF16Writer(arena, 0, layout);

        setComputeUniformF16(writer, "scalar", 1.5);
        setComputeUniformVector(writer, "vector", [2, 3]);
        setComputeUniformMatrix(writer, "matrix", [4, 5, 6, 7]);

        expect(writer._dataView.getUint16(0, true)).toBe(0x3e00);
        expect(writer._dataView.getUint16(4, true)).toBe(0x4000);
        expect(writer._dataView.getUint16(6, true)).toBe(0x4200);
        expect(writer._dataView.getUint16(8, true)).toBe(0x4400);
        expect(writer._dataView.getUint16(10, true)).toBe(0x4500);
        expect(writer._dataView.getUint16(12, true)).toBe(0x4600);
        expect(writer._dataView.getUint16(14, true)).toBe(0x4700);
    });

    it("rejects f16 writers when the engine was created without the feature", () => {
        const { engine } = makeEngine();
        const task = createComputeTask(engine);
        const layout = createComputeUniformLayout([{ name: "value", type: "f16" }]);
        const arena = createComputeUniformArena(task, layout.byteLength, 1);

        expect(() => createComputeUniformF16Writer(arena, 0, layout)).toThrow(/requiredFeatures/);
    });

    it("rejects layouts that do not fit the target arena slot and disposed writers", () => {
        const { engine } = makeEngine();
        const task = createComputeTask(engine);
        const small = createComputeUniformArena(task, 16, 1);
        const largeLayout = createComputeUniformLayout([{ name: "matrix", type: "mat4x4<f32>" }]);

        expect(() => createComputeUniformWriter(small, 0, largeLayout)).toThrow(/requires 64 bytes/);

        const writer = createComputeUniformWriter(small, 0, createComputeUniformLayout([{ name: "value", type: "f32" }]));
        task.dispose();
        expect(() => setComputeUniformF32(writer, "value", 1)).toThrow(/disposed uniform arena/);
    });
});
