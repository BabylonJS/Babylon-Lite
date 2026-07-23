import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { setShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import { createShadowTask } from "../../../packages/babylon-lite/src/frame-graph/shadow-task";
import type { MorphTargetData } from "../../../packages/babylon-lite/src/animation/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

function identity(): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

describe("shadow task input preload", () => {
    it("keeps rendering when the same preloaded caster array is supplied again", async () => {
        const casterMeshes = [{} as Mesh];
        const state: ShadowTaskInternalState = {
            _task: {
                record: vi.fn(),
                dispose: vi.fn(),
            },
            _casterMeshes: casterMeshes,
        };
        const preload = vi.fn(() => Promise.resolve());
        const shadowGenerator = {
            _preloadShadowTask: preload,
            _ensureShadowTaskState: vi.fn(() => state),
            _renderShadowMap: vi.fn(() => 1),
        } as unknown as ShadowGenerator;
        const scene = {
            lights: [{ shadowGenerator }],
            _renderableVersion: 0,
        } as unknown as SceneContext;
        setShadowTaskCasterMeshes(shadowGenerator, casterMeshes);
        const task = createShadowTask({} as EngineContext, scene);
        await task._preload!();
        expect(task.execute!()).toBe(1);

        setShadowTaskCasterMeshes(shadowGenerator, casterMeshes);

        expect(task.execute!()).toBe(1);
        expect(preload).toHaveBeenCalledTimes(1);
    });

    it("loads thin-instance caster bounds before marking new inputs ready", async () => {
        const matrices = new Float32Array(32);
        matrices.set(identity(), 0);
        matrices.set(identity(), 16);
        matrices[28] = 20;
        const mesh = {
            _cpuPositions: new Float32Array([-1, 0, 0, 1, 0, 0]),
            boundMin: [-1, 0, 0],
            boundMax: [1, 0, 0],
            worldMatrix: identity(),
            worldMatrixVersion: 1,
            thinInstances: {
                matrices,
                count: 2,
                _version: 1,
            },
        } as unknown as Mesh;
        const shadowGenerator = { _preloadShadowTask: () => Promise.resolve() } as unknown as ShadowGenerator;
        const task = createShadowTask({} as EngineContext, { lights: [{ shadowGenerator }] } as unknown as SceneContext);

        setShadowTaskCasterMeshes(shadowGenerator, [mesh]);
        await task._preload!();

        const { casterWorldAabb } = await import("../../../packages/babylon-lite/src/shadow/caster-world-aabb");
        expect(casterWorldAabb(mesh)?.[1][0]).toBeCloseTo(21);
    });

    it("reloads optional bounds when an unchanged caster array gains features", async () => {
        const mesh = {} as Mesh;
        const existingMorphTargets = {
            count: 0,
            weights: new Float32Array(),
            targets: [],
        } as unknown as MorphTargetData;
        const casterMeshes = [mesh, { morphTargets: existingMorphTargets } as Mesh];
        const state: ShadowTaskInternalState = {
            _task: {
                record: vi.fn(),
                dispose: vi.fn(),
            },
            _casterMeshes: casterMeshes,
        };
        const preload = vi.fn(() => Promise.resolve());
        const shadowGenerator = {
            _preloadShadowTask: preload,
            _ensureShadowTaskState: vi.fn(() => state),
            _renderShadowMap: vi.fn(() => 1),
        } as unknown as ShadowGenerator;
        const scene = {
            lights: [{ shadowGenerator }],
            _renderableVersion: 0,
        } as unknown as SceneContext;
        setShadowTaskCasterMeshes(shadowGenerator, casterMeshes);
        const task = createShadowTask({} as EngineContext, scene);
        await task._preload!();
        expect(task.execute!()).toBe(1);

        mesh.thinInstances = {
            matrices: identity(),
            count: 1,
            _version: 1,
        } as NonNullable<Mesh["thinInstances"]>;
        expect(task.execute!()).toBe(0);
        await vi.waitFor(() => expect(task.execute!()).toBe(1));

        mesh.morphTargets = {
            count: 0,
            weights: new Float32Array(),
            targets: [],
        } as unknown as MorphTargetData;
        expect(task.execute!()).toBe(0);
        await vi.waitFor(() => expect(task.execute!()).toBe(1));
        expect(mesh.morphTargets._shadowVersion).toBe(1);
        expect(preload).toHaveBeenCalledTimes(3);
    });
});
