import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MorphTargetData, SkeletonData } from "../../../packages/babylon-lite/src/animation/types";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { enableMorphTargetShadows } from "../../../packages/babylon-lite/src/shadow/enable-morph-target-shadows";
import { enableSkeletonShadows } from "../../../packages/babylon-lite/src/shadow/enable-skeleton-shadows";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function translation(x: number): Float32Array {
    const matrix = new Float32Array(identity());
    matrix[12] = x;
    return matrix;
}

function createMesh(fields: Partial<Mesh>): Mesh {
    return {
        name: "caster",
        _cpuPositions: new Float32Array([-1, 0, 0, 1, 0, 0]),
        boundMin: [100, 0, 0],
        boundMax: [102, 0, 0],
        worldMatrix: identity(),
        worldMatrixVersion: 1,
        ...fields,
    } as unknown as Mesh;
}

function createGenerator(): {
    generator: ShadowGenerator;
    preload: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    renderedCasters: (readonly Mesh[])[];
} {
    const preload = vi.fn(async (_casterMeshes: readonly Mesh[]) => {});
    const ensure = vi.fn((_engine: EngineContext, _scene: SceneContext, casterMeshes: readonly Mesh[]) => {
        const existing = generator._shadowTaskState;
        if (existing?._casterMeshes === casterMeshes) {
            return existing;
        }
        const state: ShadowTaskInternalState = {
            _casterMeshes: casterMeshes,
            _task: {
                record: vi.fn(),
                dispose: vi.fn(),
            },
        };
        generator._shadowTaskState = state;
        return state;
    });
    const renderedCasters: (readonly Mesh[])[] = [];
    const render = vi.fn((_engine: EngineContext, state: ShadowTaskInternalState) => {
        renderedCasters.push(state._casterMeshes);
        return 1;
    });
    const generator = {
        _config: { _mapSize: 1024, _bias: 0, _forceRefreshEveryFrame: false },
        _preloadShadowTask: preload,
        _ensureShadowTaskState: ensure,
        _renderShadowMap: render,
    } as unknown as ShadowGenerator;
    return { generator, preload, ensure, render, renderedCasters };
}

describe("shadow deformation opt-ins", () => {
    it("adapts only the enabled generator to live morph bounds", async () => {
        const { generator, preload, ensure, renderedCasters } = createGenerator();
        const mesh = createMesh({
            morphTargets: {
                count: 1,
                weights: new Float32Array([0.5]),
                weightsBuffer: {} as GPUBuffer,
                targets: [{ positions: new Float32Array([12, 0, 0, 12, 0, 0]), normals: null }],
            } as unknown as MorphTargetData,
        });
        const casters = [mesh];

        enableMorphTargetShadows(generator);
        await generator._preloadShadowTask!(casters);
        const state = generator._ensureShadowTaskState!({} as EngineContext, {} as SceneContext, casters);
        generator._renderShadowMap!({} as EngineContext, state);

        const shadowMesh = preload.mock.calls[0]![0][0] as Mesh;
        expect(shadowMesh).not.toBe(mesh);
        expect(Object.getOwnPropertyDescriptor(shadowMesh, "worldMatrixVersion")?.configurable).toBe(true);
        expect(ensure.mock.calls[0]![2]).toBe(preload.mock.calls[0]![0]);
        expect(renderedCasters[0]![0]).toBe(shadowMesh);
        expect(shadowMesh.boundMin).toEqual([5, 0, 0]);
        expect(shadowMesh.boundMax).toEqual([7, 0, 0]);
        expect(state._casterMeshes).toBe(casters);
        expect(mesh.boundMin).toEqual([100, 0, 0]);

        const firstVersion = shadowMesh.worldMatrixVersion;
        generator._renderShadowMap!({} as EngineContext, state);
        expect(shadowMesh.worldMatrixVersion).toBe(firstVersion);

        mesh.morphTargets!.weights[0] = 1;
        generator._renderShadowMap!({} as EngineContext, state);

        expect(shadowMesh.boundMin).toEqual([11, 0, 0]);
        expect(shadowMesh.boundMax).toEqual([13, 0, 0]);
        expect(shadowMesh.worldMatrixVersion).toBeGreaterThan(firstVersion);
        expect(state._casterMeshes).toBe(casters);
    });

    it("ignores empty morph targets with zero weight", async () => {
        const { generator, preload } = createGenerator();
        const mesh = createMesh({
            morphTargets: {
                count: 1,
                weights: new Float32Array([0]),
                weightsBuffer: {} as GPUBuffer,
                targets: [{ positions: new Float32Array(), normals: null }],
            } as unknown as MorphTargetData,
        });

        enableMorphTargetShadows(generator);
        await generator._preloadShadowTask!([mesh]);

        const shadowMesh = preload.mock.calls[0]![0][0] as Mesh;
        expect(shadowMesh.boundMin).toEqual([-1, 0, 0]);
        expect(shadowMesh.boundMax).toEqual([1, 0, 0]);
    });

    it("adapts only the enabled generator to live skeletal bounds", async () => {
        const { generator, preload, render } = createGenerator();
        const mesh = createMesh({
            skeleton: {
                boneCount: 1,
                boneMatrices: translation(10),
                joints: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]),
                weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
                joints1: null,
                weights1: null,
            } as unknown as SkeletonData,
        });
        const casters = [mesh];

        enableSkeletonShadows(generator);
        await generator._preloadShadowTask!(casters);
        const state = generator._ensureShadowTaskState!({} as EngineContext, {} as SceneContext, casters);
        generator._renderShadowMap!({} as EngineContext, state);

        const shadowMesh = preload.mock.calls[0]![0][0] as Mesh;
        expect(shadowMesh.boundMin).toEqual([9, 0, 0]);
        expect(shadowMesh.boundMax).toEqual([11, 0, 0]);
        expect(state._casterMeshes).toBe(casters);

        mesh.skeleton!.boneMatrices.set(translation(20));
        generator._renderShadowMap!({} as EngineContext, state);

        expect(shadowMesh.boundMin).toEqual([19, 0, 0]);
        expect(shadowMesh.boundMax).toEqual([21, 0, 0]);
        expect(render).toHaveBeenCalledTimes(2);
        expect(state._casterMeshes).toBe(casters);
    });

    it("composes morph and skeleton opt-ins without wrapping the generator twice", async () => {
        const { generator, preload, ensure } = createGenerator();
        const morphMesh = createMesh({
            morphTargets: {
                count: 1,
                weights: new Float32Array([1]),
                weightsBuffer: {} as GPUBuffer,
                targets: [{ positions: new Float32Array([2, 0, 0, 2, 0, 0]), normals: null }],
            } as unknown as MorphTargetData,
        });
        const skeletonMesh = createMesh({
            morphTargets: {
                count: 1,
                weights: new Float32Array([1]),
                weightsBuffer: {} as GPUBuffer,
                targets: [{ positions: new Float32Array([2, 0, 0, 2, 0, 0]), normals: null }],
            } as unknown as MorphTargetData,
            skeleton: {
                boneCount: 1,
                boneMatrices: translation(4),
                joints: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]),
                weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
                joints1: null,
                weights1: null,
            } as unknown as SkeletonData,
        });
        const casters = [morphMesh, skeletonMesh];

        enableSkeletonShadows(generator);
        enableMorphTargetShadows(generator);
        enableMorphTargetShadows(generator);
        await generator._preloadShadowTask!(casters);
        const state = generator._ensureShadowTaskState!({} as EngineContext, {} as SceneContext, casters);
        generator._renderShadowMap!({} as EngineContext, state);

        const shadowMeshes = preload.mock.calls[0]![0] as readonly Mesh[];
        expect(shadowMeshes).toHaveLength(2);
        expect(shadowMeshes[0]!.boundMin).toEqual([1, 0, 0]);
        expect(shadowMeshes[0]!.boundMax).toEqual([3, 0, 0]);
        expect(shadowMeshes[1]!.boundMin).toEqual([3, 0, 0]);
        expect(shadowMeshes[1]!.boundMax).toEqual([7, 0, 0]);
        expect(preload).toHaveBeenCalledTimes(1);
        expect(ensure).toHaveBeenCalledTimes(1);
    });
});
