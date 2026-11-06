import { describe, expect, it, vi } from "vitest";
import { createPbrGeometryVelocity } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-velocity.js";
import { tryInvertMat4ToRef } from "../../../packages/babylon-lite/src/math/invert-mat4-to-ref.js";
import { multiplyMat4IntoBuffer } from "../../../packages/babylon-lite/src/math/multiply-mat4-into-buffer.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";

function fixture(scale: readonly [number, number, number]) {
    const world = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 1, -2, 3, 1]);
    const writes: Float32Array[] = [];
    const buffer = { destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(80), unmap: vi.fn() };
    const device = {
        createBuffer: vi.fn(() => buffer),
        queue: { writeBuffer: vi.fn((_buffer: GPUBuffer, _offset: number, data: Float32Array) => writes.push(data.slice())) },
    };
    const engine = { _device: device } as unknown as EngineContext;
    const mesh = { visible: true } as Mesh;
    return { world, writes, buffer, device, engine, mesh };
}

describe("PBR geometry velocity transform inversion", () => {
    it.each([
        [1e-4, 1e-4, 1e-4],
        [1e-8, 2e-4, -3e-3],
        [1e4, 2e4, 3e4],
    ] as const)("tracks invertible mesh scales [%f, %f, %f] during registration and animation", (x, y, z) => {
        const f = fixture([x, y, z]);
        const state = createPbrGeometryVelocity(f.engine, f.mesh, f.world, undefined);
        state._update(false);
        f.world[0] = f.world[0]! * 0.5;
        f.world[5] = f.world[5]! * 0.25;
        f.world[10] = f.world[10]! * 2;
        f.world[12] = 4;
        state._update(true);
        const delta = f.writes.at(-1)!;
        expect(delta[0]).toBeCloseTo(2);
        expect(delta[5]).toBeCloseTo(4);
        expect(delta[10]).toBeCloseTo(0.5);
        expect(delta[12]).toBeCloseTo(-7);
        expect(delta[13]).toBeCloseTo(6);
        expect(delta[14]).toBeCloseTo(1.5);
        expect(delta[16]).toBe(1);
        const allocated = f.device.createBuffer.mock.calls.length;
        state._update(false);
        expect(Array.from(f.writes.at(-1)!.subarray(0, 16))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        expect(f.device.createBuffer).toHaveBeenCalledTimes(allocated);
        state._dispose();
        expect(f.buffer.destroy).toHaveBeenCalledOnce();
    });

    it("rejects singular transforms before allocation and during animation", () => {
        const f = fixture([0, 1, 1]);
        expect(() => createPbrGeometryVelocity(f.engine, f.mesh, f.world, undefined)).toThrow("singular");
        expect(f.device.createBuffer).not.toHaveBeenCalled();
        f.world[0] = 1e-4;
        const state = createPbrGeometryVelocity(f.engine, f.mesh, f.world, undefined);
        state._update(false);
        f.world[5] = 0;
        expect(() => state._update(true)).toThrow("singular");
        state._dispose();
    });

    it("keeps excluded singular meshes neutral and recovers when their transform becomes invertible", () => {
        const f = fixture([0, 1, 1]);
        const exclusions = new Set([f.mesh]);
        const state = createPbrGeometryVelocity(f.engine, f.mesh, f.world, exclusions);
        state._update(false);
        exclusions.clear();
        expect(() => state._update(false)).toThrow("singular");
        f.world[0] = 1e-4;
        expect(() => state._update(true)).not.toThrow();
        expect(f.writes.at(-1)![16]).toBe(0);
        state._dispose();
    });

    it.each([1e-8, 1, 1e8])("uses a relative cancellation threshold at scale %f", (scale) => {
        const matrix = new Float64Array([scale, scale, 0, 0, scale, scale * (1 + 1e-12), 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
        expect(tryInvertMat4ToRef(matrix, new Float64Array(16))).toBe(false);
    });

    it("inverts a small sheared projective matrix without replacing it with identity", () => {
        const matrix = new Float32Array([1e-4, 2e-5, 0, 1e-5, 0, 2e-4, 1e-5, 0, 3e-5, 0, -4e-4, 0, 1, -2, 3, 1]);
        const inverse = new Float32Array(16);
        expect(tryInvertMat4ToRef(matrix, inverse)).toBe(true);
        const product = new Float32Array(16);
        multiplyMat4IntoBuffer(product, 0, matrix, 0, inverse, 0);
        for (let index = 0; index < 16; index++) {
            expect(product[index]).toBeCloseTo(index % 5 === 0 ? 1 : 0, 3);
        }
    });

    it("rejects non-finite or unrepresentable inverses without an identity fallback", () => {
        for (const scale of [Number.NaN, Number.POSITIVE_INFINITY, 1e-45]) {
            const f = fixture([scale, scale, scale]);
            expect(tryInvertMat4ToRef(f.world, new Float32Array(16))).toBe(false);
        }
    });
});
