import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { _getShadowCasterMaxCascade, setShadowCasterMaxCascade } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import { ensureCsmShadowTaskState, type CsmConfig, type CsmTaskState } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

function makeMesh(material?: Material): Mesh {
    return { material } as unknown as Mesh;
}

function makeTask(mesh: Mesh): RenderTask {
    const task = {
        _pendingMeshes: [{ mesh, material: mesh.material }],
        _renderables: [],
        _opaqueBindings: [],
        _directBindings: [],
        _transparentBindings: [],
        _opaqueBundles: [],
        _lastVersion: 0,
        addMesh: vi.fn((added: Mesh, opts?: { material?: Material }) => {
            task._pendingMeshes.push({ mesh: added, material: opts?.material ?? added.material });
        }),
    };
    return task as unknown as RenderTask;
}

describe("setShadowCasterMaxCascade", () => {
    it("defaults every mesh to casting into all cascades (Infinity)", () => {
        expect(_getShadowCasterMaxCascade(makeMesh())).toBe(Infinity);
    });

    it("stores a per-mesh cap without affecting other meshes", () => {
        const capped = makeMesh();
        const other = makeMesh();
        setShadowCasterMaxCascade(capped, 0);
        expect(_getShadowCasterMaxCascade(capped)).toBe(0);
        expect(_getShadowCasterMaxCascade(other)).toBe(Infinity);
    });

    it("rejects caps that are not non-negative integer cascade indexes", () => {
        const mesh = makeMesh();
        expect(() => setShadowCasterMaxCascade(mesh, -1)).toThrow(RangeError);
        expect(() => setShadowCasterMaxCascade(mesh, 0.5)).toThrow(RangeError);
        expect(() => setShadowCasterMaxCascade(mesh, Number.NaN)).toThrow(RangeError);
    });

    it("restores all-cascade casting when re-set to Infinity", () => {
        const mesh = makeMesh();
        setShadowCasterMaxCascade(mesh, 0);
        setShadowCasterMaxCascade(mesh, Infinity);
        expect(_getShadowCasterMaxCascade(mesh)).toBe(Infinity);
    });

    it("reassigns an existing caster when a re-supplied list changes its cap", () => {
        const material = { _uboVersion: 0 } as Material;
        const view = {} as MaterialView;
        const mesh = makeMesh(material);
        const tasks = [makeTask(mesh), makeTask(mesh), makeTask(mesh)];
        const state = {
            _tasks: tasks,
            _casterMeshes: [mesh],
            _renderableVersion: 1,
            _materialEpoch: 1,
            _materialViews: new Map([[material, view]]),
            _casterMatGens: new Map([[material, 0]]),
            _casterMaxCascades: new Map([[mesh, undefined]]),
        } as unknown as CsmTaskState;
        const scene = { _renderableVersion: 2, _materialEpoch: 1 } as SceneContext;

        setShadowCasterMaxCascade(mesh, 0);
        const result = ensureCsmShadowTaskState({} as EngineContext, scene, {} as ShadowGenerator, {} as CsmConfig, [mesh], state);

        expect(result).toBe(state);
        expect(tasks[0]!.addMesh).toHaveBeenCalledOnce();
        expect(tasks[1]!.addMesh).not.toHaveBeenCalled();
        expect(tasks[2]!.addMesh).not.toHaveBeenCalled();
        expect(tasks[0]!._pendingMeshes.map((entry) => entry.mesh)).toEqual([mesh]);
        expect(tasks[1]!._pendingMeshes).toHaveLength(0);
        expect(tasks[2]!._pendingMeshes).toHaveLength(0);
        expect(state._casterMaxCascades.get(mesh)).toBe(0);

        ensureCsmShadowTaskState({} as EngineContext, scene, {} as ShadowGenerator, {} as CsmConfig, [], state);
        expect(state._casterMaxCascades.has(mesh)).toBe(false);
        ensureCsmShadowTaskState({} as EngineContext, scene, {} as ShadowGenerator, {} as CsmConfig, [mesh], state);
        expect(tasks[0]!.addMesh).toHaveBeenCalledTimes(2);
    });
});
