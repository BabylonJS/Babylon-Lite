import { describe, expect, it, vi } from "vitest";

import type { MorphTargetData, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";

function identity(): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function translation(x: number, y: number, z: number): Float32Array {
    const matrix = identity();
    matrix[12] = x;
    matrix[13] = y;
    matrix[14] = z;
    return matrix;
}

function makeSkeleton(translationX = 0): SkeletonData {
    return {
        boneCount: 1,
        boneMatrices: translation(translationX, 0, 0),
        joints: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]),
        weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
        joints1: null,
        weights1: null,
    } as unknown as SkeletonData;
}

function makeMesh(fields: Partial<Mesh>): Mesh {
    return {
        _cpuPositions: new Float32Array([-1, 0, 0, 1, 0, 0]),
        worldMatrix: identity() as unknown as Mat4,
        worldMatrixVersion: 1,
        boundMin: [-1, 0, 0],
        boundMax: [1, 0, 0],
        ...fields,
    } as unknown as Mesh;
}

describe.sequential("shadow caster bounds", () => {
    it("does not cache fallback bounds while a late-added skinned caster module is loading", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const mesh = makeMesh({ skeleton: makeSkeleton(10) });

        const preload = import("../../../packages/babylon-lite/src/shadow/skinned-caster-aabb").then((mod) => mod.enableDeformableCasterAabb([mesh]));
        const beforeLoad = casterWorldAabb(mesh);
        await preload;
        const afterLoad = casterWorldAabb(mesh);

        expect(beforeLoad).toBeNull();
        expect(afterLoad?.[0][0]).toBeCloseTo(9);
        expect(afterLoad?.[1][0]).toBeCloseTo(11);
    });

    it("uses active morph weights for a morph-only caster", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableDeformableCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/skinned-caster-aabb");
        const morphTargets = {
            count: 1,
            weights: new Float32Array([0.5]),
            targets: [{ positions: new Float32Array([12, 0, 0, 12, 0, 0]), normals: null }],
        } as unknown as MorphTargetData;
        const mesh = makeMesh({ morphTargets });
        await enableDeformableCasterAabb([mesh]);

        const aabb = casterWorldAabb(mesh);

        expect(aabb?.[0][0]).toBeCloseTo(5);
        expect(aabb?.[1][0]).toBeCloseTo(7);
    });

    it("reuses cached morph delta ranges when animated weights change", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableDeformableCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/skinned-caster-aabb");
        let deltaReads = 0;
        // Getter-backed array-like data proves a weight-only update reuses the cached
        // per-target ranges instead of silently rescanning every morph delta.
        const countedDeltas = (values: readonly number[]): Float32Array => {
            const deltas: { length: number; [index: number]: number } = { length: values.length };
            for (let i = 0; i < values.length; i++) {
                Object.defineProperty(deltas, i, {
                    get: () => {
                        deltaReads++;
                        return values[i]!;
                    },
                });
            }
            return deltas as unknown as Float32Array;
        };
        const morphTargets = {
            count: 2,
            weights: new Float32Array([0.5, 0.25]),
            targets: [
                { positions: countedDeltas([2, 0, 0, 4, 0, 0]), normals: null },
                { positions: countedDeltas([-6, 0, 0, -2, 0, 0]), normals: null },
            ],
        } as unknown as MorphTargetData;
        const mesh = makeMesh({ morphTargets });
        enableDeformableCasterAabb([mesh]);

        expect(casterWorldAabb(mesh)?.[0][0]).toBeCloseTo(-1.5);
        expect(casterWorldAabb(mesh)?.[1][0]).toBeCloseTo(2.5);
        const initialDeltaReads = deltaReads;

        morphTargets.weights.set([-0.5, 0.5]);
        morphTargets._onShadowCasterChanged?.();

        expect(casterWorldAabb(mesh)?.[0][0]).toBeCloseTo(-6);
        expect(casterWorldAabb(mesh)?.[1][0]).toBeCloseTo(-1);
        expect(deltaReads).toBe(initialDeltaReads);
    });

    it("rebuilds cached skinned bounds after mutable geometry is replaced", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableDeformableCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/skinned-caster-aabb");
        const mesh = makeMesh({ skeleton: makeSkeleton() });
        await enableDeformableCasterAabb([mesh]);

        const original = casterWorldAabb(mesh);
        mesh._cpuPositions = new Float32Array([10, 0, 0, 12, 0, 0]);
        mesh.boundMin = [10, 0, 0];
        mesh.boundMax = [12, 0, 0];
        const replaced = casterWorldAabb(mesh);

        expect(original?.[0][0]).toBeCloseTo(-1);
        expect(original?.[1][0]).toBeCloseTo(1);
        expect(replaced?.[0][0]).toBeCloseTo(10);
        expect(replaced?.[1][0]).toBeCloseTo(12);
    });

    it("includes every active thin-instance transform in directional caster bounds", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableThinCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/thin-caster-aabb");
        const matrices = new Float32Array(32);
        matrices.set(identity(), 0);
        matrices.set(translation(20, 0, 0), 16);
        const thinInstances = {
            matrices,
            count: 2,
            _capacity: 2,
            _version: 1,
        } as unknown as ThinInstanceData;
        const mesh = makeMesh({ thinInstances });
        enableThinCasterAabb();

        const aabb = casterWorldAabb(mesh);

        expect(aabb?.[0][0]).toBeCloseTo(-1);
        expect(aabb?.[1][0]).toBeCloseTo(21);
    });

    it("rebuilds thin-instance bounds when the thin-instance data object is replaced", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableThinCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/thin-caster-aabb");
        const firstMatrices = new Float32Array(16);
        firstMatrices.set(identity());
        const mesh = makeMesh({
            thinInstances: {
                matrices: firstMatrices,
                count: 1,
                _capacity: 1,
                _version: 1,
            } as unknown as ThinInstanceData,
        });
        enableThinCasterAabb();
        expect(casterWorldAabb(mesh)?.[1][0]).toBeCloseTo(1);

        const replacementMatrices = new Float32Array(16);
        replacementMatrices.set(translation(20, 0, 0));
        mesh.thinInstances = {
            matrices: replacementMatrices,
            count: 1,
            _capacity: 1,
            _version: 1,
        } as unknown as ThinInstanceData;

        expect(casterWorldAabb(mesh)?.[0][0]).toBeCloseTo(19);
        expect(casterWorldAabb(mesh)?.[1][0]).toBeCloseTo(21);
    });

    it("keeps synchronous AABB lookup side-effect free when thin bounds are unavailable", async () => {
        vi.resetModules();
        const { casterBoundsVersion, casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const matrices = new Float32Array(16);
        matrices.set(translation(20, 0, 0));
        const mesh = makeMesh({
            thinInstances: {
                matrices,
                count: 1,
                _capacity: 1,
                _version: 1,
            } as unknown as ThinInstanceData,
        });
        const beforeVersion = casterBoundsVersion();

        expect(casterWorldAabb(mesh)).toBeNull();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(casterBoundsVersion()).toBe(beforeVersion);
    });

    it("combines active morph bounds with every thin-instance transform", async () => {
        vi.resetModules();
        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        const { enableDeformableCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/skinned-caster-aabb");
        const { enableThinCasterAabb } = await import("../../../packages/babylon-lite/src/shadow/thin-caster-aabb");
        const matrices = new Float32Array(32);
        matrices.set(identity(), 0);
        matrices.set(translation(20, 0, 0), 16);
        const morphTargets = {
            count: 1,
            weights: new Float32Array([0.5]),
            targets: [{ positions: new Float32Array([12, 0, 0, 12, 0, 0]), normals: null }],
        } as unknown as MorphTargetData;
        const mesh = makeMesh({
            morphTargets,
            thinInstances: {
                matrices,
                count: 2,
                _capacity: 2,
                _version: 1,
            } as unknown as ThinInstanceData,
        });
        enableDeformableCasterAabb([mesh]);
        enableThinCasterAabb();

        const aabb = casterWorldAabb(mesh);

        expect(aabb?.[0][0]).toBeCloseTo(5);
        expect(aabb?.[1][0]).toBeCloseTo(27);
    });
});
