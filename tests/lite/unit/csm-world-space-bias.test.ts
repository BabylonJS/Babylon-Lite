import { describe, expect, it } from "vitest";

import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { bumpShadowCasterEpoch } from "../../../packages/babylon-lite/src/mesh/shadow-caster-epoch";
import { setThinInstanceDrawCount, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import { _thinInstanceWorldAabb, csmWorldBiasClipOffset } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function makeThinInstances(): ThinInstanceData {
    const matrices = new Float32Array(32);
    matrices.set(identity(), 0);
    matrices.set(identity(), 16);
    matrices[28] = 10;
    return {
        matrices,
        count: 1,
        _capacity: 2,
        _version: 1,
        _gpuBuffer: { size: 2 * 64 } as GPUBuffer,
        _gpuBufferStorage: false,
        _gpuVersion: 1,
        _dirtyMin: 0,
        _dirtyMax: 2,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

describe("CSM world-space caster bias", () => {
    it("keeps the same physical offset across changing fitted cascade depth ranges", () => {
        const worldBias = 0.12;
        const shortRange = csmWorldBiasClipOffset(worldBias, -10, 50);
        const tallRange = csmWorldBiasClipOffset(worldBias, -40, 140);

        expect(shortRange * 60).toBeCloseTo(worldBias, 8);
        expect(tallRange * 180).toBeCloseTo(worldBias, 8);
        expect(shortRange).not.toBe(tallRange);
    });

    it("returns zero for invalid or collapsed ranges", () => {
        expect(csmWorldBiasClipOffset(0.1, 3, 3)).toBe(0);
        expect(csmWorldBiasClipOffset(Number.NaN, 0, 10)).toBe(0);
        expect(csmWorldBiasClipOffset(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
        expect(csmWorldBiasClipOffset(-0.1, 0, 10)).toBe(0);
    });

    it("preserves the authored distance for every positive finite range", () => {
        const worldBias = 1e-9;
        const range = 1e-7;
        expect(csmWorldBiasClipOffset(worldBias, 0, range) * range).toBeCloseTo(worldBias, 15);
    });

    it("keeps a far-bound caster inside clip space when the projection reserves bias headroom", () => {
        const near = -10;
        const fittedFar = 50;
        const worldBias = 0.12;
        const paddedFar = fittedFar + worldBias;
        const range = paddedFar - near;
        const farCasterDepth = (fittedFar - near) / range + csmWorldBiasClipOffset(worldBias, near, paddedFar);

        expect(farCasterDepth).toBeCloseTo(1, 12);
    });

    it("refreshes thin-caster bounds after count-only and same-buffer geometry updates", () => {
        const thinInstances = makeThinInstances();
        const mesh = {
            worldMatrix: identity(),
            worldMatrixVersion: 1,
            boundMin: [-0.5, -0.5, -0.5],
            boundMax: [0.5, 0.5, 0.5],
            thinInstances,
        } as unknown as Mesh;

        const first = _thinInstanceWorldAabb(mesh, thinInstances);
        expect(first?._max[0]).toBeCloseTo(0.5);

        setThinInstanceDrawCount(mesh, 2);
        const expandedCount = _thinInstanceWorldAabb(mesh, thinInstances);
        expect(expandedCount?._max[0]).toBeCloseTo(10.5);

        mesh.boundMin = [-2, -0.5, -0.5];
        mesh.boundMax = [2, 0.5, 0.5];
        bumpShadowCasterEpoch();
        const expandedGeometry = _thinInstanceWorldAabb(mesh, thinInstances);
        expect(expandedGeometry?._min[0]).toBeCloseTo(-2);
        expect(expandedGeometry?._max[0]).toBeCloseTo(12);
    });
});
