import { describe, expect, it, vi } from "vitest";

import { _vis } from "../../../packages/babylon-lite/src/engine/engine";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { enableThinInstanceDirectDraws } from "../../../packages/babylon-lite/src/mesh/enable-thin-instance-direct-draws";
import { syncThinInstanceForDraw } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import {
    addThinInstance,
    clearThinInstanceLodPartner,
    enableThinInstanceDynamicDrawCount,
    enableThinInstanceGpuCulling,
    removeThinInstance,
    setThinInstanceColors,
    setThinInstanceCount,
    setThinInstanceDrawCount,
    setThinInstanceLodPartner,
    setThinInstances,
} from "../../../packages/babylon-lite/src/mesh/thin-instance";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/mat4";

function fixture() {
    const writeBuffer = vi.fn();
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer);
    const engine = { _device: { createBuffer, queue: { writeBuffer } }, _retirements: [] } as unknown as EngineContext;
    const mesh = { _gpu: { indexCount: 36, _firstIndex: 6, _baseVertex: -4 } } as Mesh;
    setThinInstances(mesh, new Float32Array(4 * 16), 4);
    const ti = mesh.thinInstances!;
    const sync = (hasColor = false) => syncThinInstanceForDraw(engine, ti, hasColor, mesh._gpu);
    return { engine, mesh, ti, sync, writeBuffer, createBuffer };
}

describe("thin-instance opt-in direct draws", () => {
    it("keeps zero/regrowth transitions direct and invalidates once per observed count, not per pass", () => {
        const { mesh, ti, sync, createBuffer, writeBuffer } = fixture();
        enableThinInstanceDirectDraws(mesh);
        sync();
        const start = _vis;
        createBuffer.mockClear();
        writeBuffer.mockClear();

        for (const [index, count] of [2, 0, 3, 1, 4].entries()) {
            setThinInstanceDrawCount(mesh, count);
            expect(sync()).toBeNull();
            expect(_vis).toBe(start + index + 1);
            expect(sync()).toBeNull();
            expect(_vis).toBe(start + index + 1);
        }
        expect(ti._drawArgsBuffer).toBeUndefined();
        expect(createBuffer).not.toHaveBeenCalled();
        expect(writeBuffer).not.toHaveBeenCalled();
    });

    it("captures the first count without an extra epoch and leaves identical counts alone", () => {
        const { mesh, sync } = fixture();
        enableThinInstanceDirectDraws(mesh);
        const start = _vis;
        expect(sync()).toBeNull();
        expect(_vis).toBe(start + 1); // Initial matrix buffer creation.
        setThinInstanceDrawCount(mesh, 4);
        expect(sync()).toBeNull();
        expect(_vis).toBe(start + 1);
    });

    it("collapses several count-only changes to the final captured count", () => {
        const { mesh, sync } = fixture();
        enableThinInstanceDirectDraws(mesh);
        sync();
        const start = _vis;
        setThinInstanceDrawCount(mesh, 2);
        setThinInstanceDrawCount(mesh, 3);
        setThinInstanceDrawCount(mesh, 4);
        expect(sync()).toBeNull();
        expect(_vis).toBe(start);
        setThinInstanceDrawCount(mesh, 0);
        setThinInstanceDrawCount(mesh, 1);
        expect(sync()).toBeNull();
        expect(_vis).toBe(start + 1);
    });

    it("does not change another mesh's default indirect promotion", () => {
        const direct = fixture();
        const normal = fixture();
        enableThinInstanceDirectDraws(direct.mesh);
        direct.sync();
        normal.sync();
        setThinInstanceDrawCount(direct.mesh, 2);
        setThinInstanceDrawCount(normal.mesh, 2);
        expect(direct.sync()).toBeNull();
        expect(normal.sync()).toBe(normal.ti._drawArgsBuffer);
        expect(normal.ti._drawArgsBuffer).toBeTruthy();
        expect(normal.ti._drawCountPolicy).toBeUndefined();
    });

    it("retains dirty matrix/color uploads, capacity growth and count synchronization", () => {
        const { mesh, ti, sync, writeBuffer, createBuffer } = fixture();
        enableThinInstanceDirectDraws(mesh);
        setThinInstanceColors(mesh, new Float32Array(4 * 4));
        expect(sync(true)).toBeNull();
        writeBuffer.mockClear();
        setThinInstanceCount(mesh, 2);
        expect(sync(true)).toBeNull();
        expect(writeBuffer).toHaveBeenCalledOnce();
        expect(writeBuffer.mock.calls[0]![4]).toBe(2 * 64);
        removeThinInstance(mesh, 0);
        expect(sync(true)).toBeNull();
        ti.colors = null;
        setThinInstances(mesh, new Float32Array(8 * 16), 8);
        expect(sync(true)).toBeNull();
        addThinInstance(mesh, createIdentityMat4());
        expect(sync(true)).toBeNull();
        expect(ti.count).toBe(9);
        expect(ti._gpuBuffer!.size).toBe(16 * 64);
        expect(createBuffer.mock.calls.every(([descriptor]) => descriptor.size !== 20)).toBe(true);
        expect(ti._drawArgsBuffer).toBeUndefined();
    });

    it("is idempotent and follows shared thin-instance data", () => {
        const { mesh, ti, sync } = fixture();
        enableThinInstanceDirectDraws(mesh);
        const policy = ti._drawCountPolicy;
        const clone = { thinInstances: ti } as Mesh;
        enableThinInstanceDirectDraws(clone);
        expect(ti._drawCountPolicy).toBe(policy);
        sync();
        setThinInstanceDrawCount(clone, 1);
        expect(sync()).toBeNull();
    });

    it("does not acknowledge a changed count when a vertex upload fails", () => {
        const { mesh, ti, sync, writeBuffer } = fixture();
        enableThinInstanceDirectDraws(mesh);
        sync();
        const start = _vis;
        setThinInstanceCount(mesh, 2);
        writeBuffer.mockImplementationOnce(() => {
            throw new Error("vertex upload failed");
        });
        expect(sync).toThrow("vertex upload failed");
        expect(ti._drawArgsInstanceCount).toBe(4);
        expect(_vis).toBe(start);
        expect(sync()).toBeNull();
        expect(ti._drawArgsInstanceCount).toBe(2);
        expect(_vis).toBe(start + 1);
        expect(ti._drawArgsBuffer).toBeUndefined();
    });

    it("allows an existing direct snapshot but rejects already promoted stable args without mutation", () => {
        const direct = fixture();
        direct.sync();
        setThinInstanceDrawCount(direct.mesh, 2);
        enableThinInstanceDirectDraws(direct.mesh);
        const start = _vis;
        expect(direct.sync()).toBeNull();
        expect(_vis).toBe(start + 1);
        const promoted = fixture();
        promoted.sync();
        setThinInstanceDrawCount(promoted.mesh, 2);
        promoted.sync();
        const args = promoted.ti._drawArgsBuffer;
        expect(() => enableThinInstanceDirectDraws(promoted.mesh)).toThrow("stable indirect");
        expect(promoted.ti._drawCountPolicy).toBeUndefined();
        expect(promoted.ti._drawArgsBuffer).toBe(args);
    });

    it("rejects missing data and indirect warm-up in both orders before mutation", () => {
        expect(() => enableThinInstanceDirectDraws({} as Mesh)).toThrow("requires mesh.thinInstances");
        const before = fixture();
        enableThinInstanceDynamicDrawCount(before.mesh);
        expect(() => enableThinInstanceDirectDraws(before.mesh)).toThrow("warm-up");
        expect(before.ti._drawCountPolicy).toBeUndefined();
        expect(before.ti._drawArgsInstanceCount).toBe(-1);
        const after = fixture();
        enableThinInstanceDirectDraws(after.mesh);
        expect(() => enableThinInstanceDynamicDrawCount(after.mesh)).toThrow("warm-up");
        expect(after.ti._drawArgsInstanceCount).toBeUndefined();
    });

    it("rejects GPU culling in both orders but allows disabling it", () => {
        const { mesh, ti } = fixture();
        enableThinInstanceGpuCulling(mesh);
        const version = ti._gpuVersion;
        expect(() => enableThinInstanceDirectDraws(mesh)).toThrow("GPU culling");
        expect(ti._gpuCullingEnabled).toBe(true);
        expect(ti._gpuVersion).toBe(version);
        enableThinInstanceGpuCulling(mesh, false);
        enableThinInstanceDirectDraws(mesh);
        expect(() => enableThinInstanceGpuCulling(mesh)).toThrow("GPU culling");
        expect(ti._gpuCullingEnabled).toBe(false);
        expect(() => enableThinInstanceGpuCulling(mesh, false)).not.toThrow();
    });

    it.each(["source", "partner"] as const)("rejects direct %s LOD pairing in both orders without disturbing existing pairs", (role) => {
        const full = fixture();
        const lod = fixture();
        const direct = role === "source" ? full : lod;
        enableThinInstanceDirectDraws(direct.mesh);
        expect(() => setThinInstanceLodPartner(full.mesh, lod.mesh, { distance: 10 })).toThrow("LOD pairing");
        expect(full.ti._lodPartner).toBeUndefined();
        expect(lod.ti._lodSource).toBeUndefined();
        expect(lod.ti._gpuCullingEnabled).toBe(false);

        const pairedFull = fixture();
        const pairedLod = fixture();
        setThinInstanceLodPartner(pairedFull.mesh, pairedLod.mesh, { distance: 10 });
        const pairedDirect = role === "source" ? pairedFull : pairedLod;
        expect(() => enableThinInstanceDirectDraws(pairedDirect.mesh)).toThrow(/GPU culling|LOD pairing/);
        expect(pairedDirect.ti._drawCountPolicy).toBeUndefined();
        expect(pairedFull.ti._lodPartner).toBe(pairedLod.mesh);
        expect(pairedLod.ti._lodSource).toBe(pairedFull.mesh);
        expect(() => setThinInstanceLodPartner(pairedFull.mesh, direct.mesh, { distance: 15 })).toThrow("LOD pairing");
        expect(pairedFull.ti._lodPartner).toBe(pairedLod.mesh);
        expect(pairedLod.ti._lodSource).toBe(pairedFull.mesh);
        clearThinInstanceLodPartner(pairedFull.mesh);
        enableThinInstanceDirectDraws(pairedDirect.mesh);
    });
});
