import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { enableRenderTaskMeshRefresh } from "../../../packages/babylon-lite/src/frame-graph/render-task-mesh-refresh";
import { _buildBindings, _rebindRenderTask, _resolvePendingMeshes, removeMeshFromTask, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { retireTaskBatches, retireTaskMesh, transactRenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task-transaction";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { DrawUpdateBatch, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function createRenderable(mesh: Mesh, batch: DrawUpdateBatch, isTransparent = false, direct = false): Renderable {
    const renderable: Renderable = {
        order: 0,
        isTransparent,
        _direct: direct,
        mesh,
        bind: () => ({
            renderable,
            pipeline: {} as GPURenderPipeline,
            draw: () => 1,
            _updateBatches: [batch],
        }),
    };
    return renderable;
}

function createTask(engine: EngineContext, scene: SceneContext): RenderTask {
    const targetSignature: RenderTargetSignature = { _colorFormat: "rgba8unorm", _sampleCount: 1 };
    const task = {
        name: "dynamic",
        engine,
        scene,
        _config: { autoMirror: false },
        _passes: [],
        _renderables: [],
        _opaqueBindings: [],
        _directBindings: [],
        _transparentBindings: [],
        _ob: [],
        _lastVersion: -1,
        _lastVis: 0,
        _recorded: false,
        _targetSignature: targetSignature,
        _updateBatches: [],
        _pendingMeshes: [],
        addMesh(mesh: Mesh, options?: { material?: Material }) {
            const material = options?.material ?? mesh.material;
            if (material) {
                task._pendingMeshes.push({ mesh, material });
                if (task._recorded) {
                    _rebindRenderTask(task, true);
                }
            }
        },
        record() {
            transactRenderTask(
                task,
                (candidate) => {
                    candidate._prepareTaskMeshes?.(candidate);
                    _resolvePendingMeshes(candidate, scene);
                    candidate._recorded = true;
                },
                (candidate) => _buildBindings(candidate, engine, targetSignature)
            );
        },
        execute: vi.fn(() => 0),
        dispose: vi.fn(() => {
            for (const entry of task._meshEntries ?? []) {
                retireTaskMesh(task, entry);
            }
            task._meshEntries = undefined;
            retireTaskBatches(task, task._updateBatches);
            task._updateBatches = [];
        }),
    } as unknown as RenderTask;
    return task;
}

function createRefreshScene(engine: EngineContext, mesh: Mesh, renderables: Renderable[]): { scene: SceneContext; disposed: ReturnType<typeof vi.fn>[] } {
    const disposed: ReturnType<typeof vi.fn>[] = [];
    let build = 0;
    const builder = Object.assign(async () => ({ renderables: [], rebuildSingle: builder._rebuildSingle! }), {
        _rebuildSingle: (_scene: SceneContext, selectedMesh: Mesh): Renderable => {
            const dispose = vi.fn();
            disposed.push(dispose);
            const list = scene._meshAuxDisposables.get(selectedMesh) ?? [];
            list.push(dispose);
            scene._meshAuxDisposables.set(selectedMesh, list);
            return renderables[Math.min(build++, renderables.length - 1)]!;
        },
    });
    mesh.material = { _buildGroup: builder, _uboVersion: 0 } as unknown as Material;
    const scene = {
        surface: { engine },
        _groups: new Map([[builder, { r: builder._rebuildSingle }]]),
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _renderables: [],
        _renderableVersion: 1,
    } as unknown as SceneContext;
    return { scene, disposed };
}

function createTransactionFixture() {
    const engine = { _retirements: null } as EngineContext;
    const meshes = [{} as Mesh, {} as Mesh];
    const { scene } = createRefreshScene(engine, meshes[0]!, []);
    meshes[1]!.material = meshes[0]!.material;
    const builder = meshes[0]!.material!._buildGroup;
    const sceneDisposers = meshes.map(() => [vi.fn()]);
    const sceneAux = meshes.map(() => [vi.fn()]);
    for (let index = 0; index < meshes.length; index++) {
        scene._meshDisposables.set(meshes[index]!, sceneDisposers[index]!);
        scene._meshAuxDisposables.set(meshes[index]!, sceneAux[index]!);
    }
    const built: { renderable: Renderable; dispose: ReturnType<typeof vi.fn>; bindDispose: ReturnType<typeof vi.fn>; batch: DrawUpdateBatch }[] = [];
    let failure: "build" | "bind" | undefined;
    let reusedBatch: DrawUpdateBatch | undefined;
    scene._groups.get(builder)!.r = (_scene, mesh) => {
        const dispose = vi.fn();
        const bindDispose = vi.fn();
        const batch = mesh === meshes[0] && reusedBatch ? reusedBatch : { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const renderable = createRenderable(mesh, batch, mesh === meshes[1]);
        const bind = renderable.bind;
        renderable.bind = (device, signature) => {
            scene._meshDisposables.get(mesh)!.push(bindDispose);
            if (failure === "bind" && mesh === meshes[1]) {
                throw new Error("binding failed");
            }
            return bind(device, signature);
        };
        built.push({ renderable, dispose, bindDispose, batch });
        if (mesh === meshes[0]) {
            scene._meshDisposables.set(mesh, [dispose]);
        } else {
            scene._meshAuxDisposables.get(mesh)!.push(dispose);
        }
        if (failure === "build" && mesh === meshes[1]) {
            throw new Error("building failed");
        }
        return renderable;
    };
    const task = createTask(engine, scene);
    const execute = task.execute!;
    const untracked = createRenderable({} as Mesh, { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() }, false, true);
    task._renderables.push(untracked);
    enableRenderTaskMeshRefresh(task);
    for (const mesh of meshes) {
        task.addMesh(mesh);
    }
    return {
        engine,
        scene,
        meshes,
        sceneDisposers,
        sceneAux,
        task,
        built,
        untracked,
        execute,
        fail: (phase?: "build" | "bind") => {
            failure = phase;
        },
        reuse: (batch: DrawUpdateBatch) => {
            reusedBatch = batch;
        },
    };
}

function currentGeneration(task: RenderTask) {
    return {
        renderables: task._renderables,
        opaque: task._opaqueBindings,
        direct: task._directBindings,
        transparent: task._transparentBindings,
        batches: task._updateBatches,
        bundles: task._ob,
        version: task._lastVersion,
        recorded: task._recorded,
    };
}

function overrideMaterial() {
    let failure: "build" | "bind" | undefined;
    const built: { renderable: Renderable; dispose: ReturnType<typeof vi.fn>; bindDisposers: ReturnType<typeof vi.fn>[] }[] = [];
    const builder = Object.assign(async () => ({ renderables: [], rebuildSingle: builder._rebuildSingle }), {
        _sceneIndependentRebuild: true,
        _rebuildSingle(scene: SceneContext, mesh: Mesh): Renderable {
            const dispose = vi.fn();
            const bindDisposers: ReturnType<typeof vi.fn>[] = [];
            const batch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
            const renderable = createRenderable(mesh, batch);
            const bind = renderable.bind;
            renderable.bind = (engine, signature) => {
                const callback = vi.fn();
                bindDisposers.push(callback);
                scene._meshAuxDisposables.get(mesh)!.push(callback);
                if (failure === "bind") {
                    throw new Error("override binding failed");
                }
                return bind(engine, signature);
            };
            built.push({ renderable, dispose, bindDisposers });
            scene._meshDisposables.set(mesh, [dispose]);
            if (failure === "build") {
                throw new Error("override building failed");
            }
            return renderable;
        },
    });
    const material: Material = { _buildGroup: builder, _uboVersion: 0 };
    return {
        material,
        built,
        fail: (phase?: "build" | "bind") => {
            failure = phase;
        },
    };
}

describe("render task mesh refresh", () => {
    it.each([
        ["tracked", false],
        ["override", false],
        ["tracked", true],
        ["override", true],
    ] as const)("retains a %s addition when its scene group is unfinished (live: %s)", (kind, live) => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const { scene } = createRefreshScene(engine, mesh, []);
        const builder = mesh.material!._buildGroup;
        const foreignRebuild = vi.fn(() => {
            throw new Error("Foreign scene context used.");
        });
        builder._rebuildSingle = foreignRebuild;
        const foreignScene = { _groups: new Map([[builder, { r: foreignRebuild }]]) } as unknown as SceneContext;
        expect(foreignScene._groups.get(builder)!.r).toBe(builder._rebuildSingle);
        const group = scene._groups.get(builder)!;
        group.r = undefined;
        const task = createTask(engine, scene);
        enableRenderTaskMeshRefresh(task);
        if (live) {
            task.record();
        }
        const previous = currentGeneration(task);
        const add = () => task.addMesh(mesh, kind === "override" ? { material: mesh.material! } : undefined);
        if (live) {
            expect(add).toThrow(/initial build in this scene/);
        } else {
            add();
            expect(() => task.record()).toThrow(/initial build in this scene/);
        }
        expect(currentGeneration(task)).toEqual(previous);
        expect(foreignRebuild).not.toHaveBeenCalled();
        expect(task._pendingMeshes).toHaveLength(kind === "override" ? 1 : 0);

        const batch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const renderable = createRenderable(mesh, batch);
        const bind = vi.spyOn(renderable, "bind");
        const localRebuild = vi.fn(() => renderable);
        group.r = localRebuild;
        if (live) {
            task.execute!();
        } else {
            task.record();
        }
        expect(localRebuild).toHaveBeenCalledWith(scene, mesh, mesh.material);
        expect(bind).toHaveBeenCalledWith(engine, task._targetSignature);
        expect(task._renderables).toEqual([renderable]);
        expect(task._pendingMeshes).toHaveLength(0);
        expect(foreignRebuild).not.toHaveBeenCalled();
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("requires an explicit standalone rebuild contract even when no scene group exists", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const { scene } = createRefreshScene(engine, mesh, []);
        const override = overrideMaterial();
        override.material._buildGroup._sceneIndependentRebuild = false;
        const task = createTask(engine, scene);
        enableRenderTaskMeshRefresh(task);
        task.addMesh(mesh, { material: override.material });
        expect(() => task.record()).toThrow(/initial build in this scene/);
        expect(task._pendingMeshes).toHaveLength(1);
        expect(override.built).toHaveLength(0);
        override.material._buildGroup._sceneIndependentRebuild = true;
        task.record();
        expect(override.built).toHaveLength(1);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("retires every successful override binding generation while retaining the renderable lifetime", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const { scene } = createRefreshScene(engine, mesh, []);
        const override = overrideMaterial();
        const task = createTask(engine, scene);
        enableRenderTaskMeshRefresh(task);
        task.addMesh(mesh, { material: override.material });
        task.record();
        const lifetime = override.built[0]!;
        for (let generation = 1; generation <= 4; generation++) {
            scene._renderableVersion++;
            task.execute!();
            expect(override.built).toHaveLength(1);
            expect(task._renderables).toEqual([lifetime.renderable]);
            expect(lifetime.dispose).not.toHaveBeenCalled();
            expect(lifetime.bindDisposers[generation - 1]).not.toHaveBeenCalled();
            disposeGpuResourceRetirements(engine);
            for (const previous of lifetime.bindDisposers.slice(0, generation)) {
                expect(previous).toHaveBeenCalledOnce();
            }
            expect(lifetime.bindDisposers[generation]).not.toHaveBeenCalled();
        }
        override.fail("bind");
        scene._renderableVersion++;
        expect(() => task.execute!()).toThrow("override binding failed");
        expect(lifetime.bindDisposers[4]).not.toHaveBeenCalled();
        expect(lifetime.bindDisposers[5]).toHaveBeenCalledOnce();
        override.fail();
        task.execute!();
        disposeGpuResourceRetirements(engine);
        expect(lifetime.bindDisposers[4]).toHaveBeenCalledOnce();
        expect(lifetime.bindDisposers[6]).not.toHaveBeenCalled();
        removeMeshFromTask(task, mesh);
        task.execute!();
        disposeGpuResourceRetirements(engine);
        expect(lifetime.dispose).toHaveBeenCalledOnce();
        for (const callback of lifetime.bindDisposers) {
            expect(callback).toHaveBeenCalledOnce();
        }
    });

    it("keeps cached resources registered during bind alive through successful rebinds", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const { scene } = createRefreshScene(engine, mesh, []);
        const lifetimeDispose = vi.fn();
        const cachedDispose = vi.fn();
        const generationDisposers: ReturnType<typeof vi.fn>[] = [];
        const batch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const renderable = createRenderable(mesh, batch);
        const bind = renderable.bind;
        let cached = false;
        renderable.bind = (engine, signature) => {
            if (!cached) {
                cached = true;
                renderable._lifetimeDisposers!.push(cachedDispose);
            }
            const dispose = vi.fn();
            generationDisposers.push(dispose);
            scene._meshDisposables.get(mesh)!.push(dispose);
            return bind(engine, signature);
        };
        const builder = Object.assign(async () => ({ renderables: [], rebuildSingle: builder._rebuildSingle }), {
            _rebuildSingle: () => {
                scene._meshDisposables.set(mesh, [lifetimeDispose]);
                return renderable;
            },
        });
        scene._groups.set(builder, Object.assign([mesh], { r: builder._rebuildSingle }));
        const material: Material = { _buildGroup: builder, _uboVersion: 0 };
        const task = createTask(engine, scene);
        enableRenderTaskMeshRefresh(task);
        task.addMesh(mesh, { material });
        task.record();
        scene._renderableVersion++;
        task.execute!();
        disposeGpuResourceRetirements(engine);
        expect(cachedDispose).not.toHaveBeenCalled();
        expect(lifetimeDispose).not.toHaveBeenCalled();
        expect(generationDisposers[0]).toHaveBeenCalledOnce();
        expect(generationDisposers[1]).not.toHaveBeenCalled();
        task.dispose();
        disposeGpuResourceRetirements(engine);
        expect(cachedDispose).toHaveBeenCalledOnce();
        expect(lifetimeDispose).toHaveBeenCalledOnce();
        expect(generationDisposers[1]).toHaveBeenCalledOnce();
    });

    it("rebinds rebuilt scene renderables and retires batches after the last tracked mesh is removed", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const firstBatch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const secondBatch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const first = createRenderable(mesh, firstBatch);
        const second = createRenderable(mesh, secondBatch);
        const { scene, disposed } = createRefreshScene(engine, mesh, [first, second]);
        const task = createTask(engine, scene);

        enableRenderTaskMeshRefresh(task);
        task.addMesh(mesh);
        task.record();
        expect(task._renderables).toEqual([first]);
        expect(task._updateBatches).toEqual([firstBatch]);

        scene._renderables = [second];
        scene._renderableVersion++;
        task.execute!();
        expect(task._renderables).toEqual([second]);
        expect(task._updateBatches).toEqual([secondBatch]);
        disposeGpuResourceRetirements(engine);
        expect(firstBatch.destroy).toHaveBeenCalledOnce();
        expect(disposed[0]).toHaveBeenCalledOnce();

        scene._renderableVersion++;
        removeMeshFromTask(task, mesh);
        task.execute!();
        disposeGpuResourceRetirements(engine);
        expect(secondBatch.destroy).toHaveBeenCalledOnce();
        expect(disposed[1]).toHaveBeenCalledOnce();
        expect(task._updateBatches).toEqual([]);
    });

    it("builds one auxiliary mesh renderable instead of reusing a merged scene renderable", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const selectedBatch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const selected = createRenderable(mesh, selectedBatch);
        const merged: Renderable = {
            order: 0,
            isTransparent: false,
            bind: vi.fn(() => {
                throw new Error("explicit refresh must never bind the merged sibling set");
            }),
        };
        const { scene } = createRefreshScene(engine, mesh, [selected]);
        scene._renderables = [merged];
        const task = createTask(engine, scene);

        enableRenderTaskMeshRefresh(task);
        task.addMesh(mesh);
        task.record();

        expect(task._renderables).toEqual([selected]);
        expect(merged.bind).not.toHaveBeenCalled();
    });

    it.each(["build", "bind"] as const)("preserves the entire live generation after a later mesh %s failure and retries cleanly", (phase) => {
        const f = createTransactionFixture();
        f.task.record();
        const previous = currentGeneration(f.task);
        const live = f.built.slice();
        f.scene._renderableVersion++;
        f.fail(phase);

        expect(() => f.task.execute!()).toThrow(phase === "build" ? "building failed" : "binding failed");
        expect(currentGeneration(f.task)).toEqual(previous);
        expect(f.task._renderables).toBe(previous.renderables);
        expect(f.task._opaqueBindings).toBe(previous.opaque);
        expect(f.task._directBindings).toBe(previous.direct);
        expect(f.task._transparentBindings).toBe(previous.transparent);
        expect(f.task._updateBatches).toBe(previous.batches);
        expect(f.task._ob).toBe(previous.bundles);
        expect(f.execute).not.toHaveBeenCalled();

        const abandoned = f.built.slice(2);
        for (const item of abandoned) {
            expect(item.dispose).toHaveBeenCalledOnce();
            if (phase === "bind") {
                expect(item.bindDispose).toHaveBeenCalledOnce();
            }
        }
        if (phase === "bind") {
            expect(abandoned[0]!.batch.destroy).toHaveBeenCalledOnce();
        }
        disposeGpuResourceRetirements(f.engine);
        for (const item of live) {
            expect(item.dispose).not.toHaveBeenCalled();
            expect(item.bindDispose).not.toHaveBeenCalled();
            expect(item.batch.destroy).not.toHaveBeenCalled();
        }
        for (let index = 0; index < f.meshes.length; index++) {
            expect(f.scene._meshDisposables.get(f.meshes[index]!)).toBe(f.sceneDisposers[index]);
            expect(f.scene._meshAuxDisposables.get(f.meshes[index]!)).toBe(f.sceneAux[index]);
            expect(f.sceneDisposers[index]![0]).not.toHaveBeenCalled();
            expect(f.sceneAux[index]![0]).not.toHaveBeenCalled();
        }

        f.fail();
        f.task.execute!();
        expect(f.task._renderables).toEqual([f.untracked, ...f.built.slice(4).map((item) => item.renderable)]);
        expect(f.task._lastVersion).toBe(f.scene._renderableVersion);
        disposeGpuResourceRetirements(f.engine);
        for (const item of live) {
            expect(item.dispose).toHaveBeenCalledOnce();
            expect(item.bindDispose).toHaveBeenCalledOnce();
            expect(item.batch.destroy).toHaveBeenCalledOnce();
        }
        for (const item of abandoned) {
            expect(item.dispose).toHaveBeenCalledOnce();
        }
        f.task.execute!();
        expect(f.built).toHaveLength(6);
    });

    it("rolls back a failed first record and does not retain a partially built task", () => {
        const f = createTransactionFixture();
        const previous = currentGeneration(f.task);
        f.fail("bind");
        expect(() => f.task.record()).toThrow("binding failed");
        expect(currentGeneration(f.task)).toEqual(previous);
        for (const item of f.built) {
            expect(item.dispose).toHaveBeenCalledOnce();
            expect(item.bindDispose).toHaveBeenCalledOnce();
        }
        f.fail();
        f.task.record();
        expect(f.task._recorded).toBe(true);
        expect(f.task._renderables).toEqual([f.untracked, ...f.built.slice(2).map((item) => item.renderable)]);
    });

    it("does not destroy a live update batch reused by an abandoned candidate", () => {
        const f = createTransactionFixture();
        f.task.record();
        const batch = f.built[0]!.batch;
        f.reuse(batch);
        f.scene._renderableVersion++;
        f.fail("bind");
        expect(() => f.task.execute!()).toThrow("binding failed");
        disposeGpuResourceRetirements(f.engine);
        expect(batch.destroy).not.toHaveBeenCalled();
        f.fail();
        f.task.execute!();
        disposeGpuResourceRetirements(f.engine);
        expect(batch.destroy).not.toHaveBeenCalled();
        expect(f.task._updateBatches).toContain(batch);
    });

    it.each(["build", "bind"] as const)("rolls back mixed tracked/override recording after a later override %s failure", (phase) => {
        const f = createTransactionFixture();
        const first = overrideMaterial();
        const second = overrideMaterial();
        f.task.addMesh(f.meshes[0]!, { material: first.material });
        f.task.addMesh(f.meshes[1]!, { material: second.material });
        second.fail(phase);
        const previous = currentGeneration(f.task);
        const pending = f.task._pendingMeshes;

        for (let attempt = 0; attempt < 2; attempt++) {
            expect(() => f.task.record()).toThrow(/override .* failed/);
            expect(currentGeneration(f.task)).toEqual(previous);
            expect(f.task._pendingMeshes).toBe(pending);
            expect(pending).toHaveLength(2);
            for (const entry of [...first.built, ...second.built]) {
                expect(entry.dispose).toHaveBeenCalledOnce();
                for (const callback of entry.bindDisposers) {
                    expect(callback).toHaveBeenCalledOnce();
                }
            }
            for (let index = 0; index < f.meshes.length; index++) {
                expect(f.scene._meshDisposables.get(f.meshes[index]!)).toBe(f.sceneDisposers[index]);
                expect(f.scene._meshAuxDisposables.get(f.meshes[index]!)).toBe(f.sceneAux[index]);
            }
        }
        second.fail();
        f.task.record();
        expect(f.task._pendingMeshes).toHaveLength(0);
        expect(f.task._renderables).toEqual([f.untracked, ...f.built.slice(-2).map((entry) => entry.renderable), first.built[2]!.renderable, second.built[2]!.renderable]);
        f.task.dispose();
        disposeGpuResourceRetirements(f.engine);
        for (const entry of [...first.built, ...second.built]) {
            expect(entry.dispose).toHaveBeenCalledOnce();
            for (const callback of entry.bindDisposers) {
                expect(callback).toHaveBeenCalledOnce();
            }
        }
    });

    it("captures overrides queued before enabling refresh, even without tracked meshes", () => {
        const engine = { _retirements: null } as EngineContext;
        const mesh = {} as Mesh;
        const { scene } = createRefreshScene(engine, mesh, []);
        const override = overrideMaterial();
        const task = createTask(engine, scene);
        task.addMesh(mesh, { material: override.material });
        enableRenderTaskMeshRefresh(task);
        override.fail("bind");
        expect(() => task.record()).toThrow("override binding failed");
        expect(task._pendingMeshes).toHaveLength(1);
        expect(override.built[0]!.dispose).toHaveBeenCalledOnce();
        expect(scene._meshDisposables.has(mesh)).toBe(false);
        expect(scene._meshAuxDisposables.has(mesh)).toBe(false);
        override.fail();
        task.record();
        expect(task._renderables).toEqual([override.built[1]!.renderable]);
        removeMeshFromTask(task, mesh);
        task.execute!();
        disposeGpuResourceRetirements(engine);
        expect(override.built[1]!.dispose).toHaveBeenCalledOnce();
        expect(task._renderables).toHaveLength(0);
    });

    it("stages live override additions and retained-override binding callbacks on failure", () => {
        const f = createTransactionFixture();
        f.task.record();
        const retained = overrideMaterial();
        f.task.addMesh(f.meshes[0]!, { material: retained.material });
        const live = retained.built[0]!;
        expect(f.task._renderables).toContain(live.renderable);
        const previous = currentGeneration(f.task);
        const next = overrideMaterial();
        next.fail("bind");
        expect(() => f.task.addMesh(f.meshes[1]!, { material: next.material })).toThrow("override binding failed");
        expect(currentGeneration(f.task)).toEqual(previous);
        expect(f.task._pendingMeshes).toHaveLength(1);
        expect(live.dispose).not.toHaveBeenCalled();
        expect(live.bindDisposers[0]).not.toHaveBeenCalled();
        expect(live.bindDisposers[1]).toHaveBeenCalledOnce();
        expect(next.built[0]!.dispose).toHaveBeenCalledOnce();
        next.fail();
        f.task.execute!();
        expect(f.task._renderables.filter((renderable) => renderable === live.renderable)).toHaveLength(1);
        expect(f.task._pendingMeshes).toHaveLength(0);
        f.task.dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(live.dispose).toHaveBeenCalledOnce();
        for (const callback of live.bindDisposers) {
            expect(callback).toHaveBeenCalledOnce();
        }
    });
});
