import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { rebuildMaterial } from "../../../packages/babylon-lite/src/material/material-rebuild";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type RuntimeSceneBuildHooks, type SceneContext, type SceneMeshGroup } from "../../../packages/babylon-lite/src/scene/scene-core";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import { rebuildScenePbrPipelines } from "../../../packages/babylon-lite/src/scene/scene-rebuild";
import { B as startRuntimeMeshBuild } from "../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build";
import { _t } from "../../../packages/babylon-lite/src/frame-graph/transmission";

function createScene(engine: EngineContext): SceneContext {
    return {
        surface: { engine },
        meshes: [],
        lights: [],
        _groups: new Map(),
        _deferredBuilders: [],
        _renderables: [],
        _uniformUpdaters: [],
        _disposables: [],
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _materialSwapQueue: [],
        _beforeRender: [],
        _renderableVersion: 0,
        _materialEpoch: 0,
        _built: false,
        _frameGraph: { build: vi.fn(), _tasks: [] },
    } as unknown as SceneContext;
}

function renderable(mesh: Mesh): Renderable {
    return { mesh, order: 100, isTransparent: false } as Renderable;
}

describe("runtime material rebuild ownership", () => {
    it("skips a queued mesh whose material was cleared", () => {
        const runtimeBuild = vi.fn();
        const mesh = { material: null, _runtimeThinBuild: runtimeBuild } as unknown as Mesh;
        const scene = createScene({} as EngineContext);
        scene._materialSwapQueue.push(mesh);

        expect(() => processMaterialSwaps(scene)).not.toThrow();
        expect(runtimeBuild).not.toHaveBeenCalled();
        expect(scene._materialSwapQueue).toHaveLength(0);
    });

    it("restores cached material features when a transmission rebuild rolls back", () => {
        const engine = {} as EngineContext;
        const scene = createScene(engine);
        const features = {};
        const material = { _linearImageProcessing: false, _renderFeatures: features } as unknown as Material;
        scene.meshes.push({ material } as Mesh, { material: null } as unknown as Mesh);

        let transaction!: ReturnType<typeof _t>;
        expect(() => (transaction = _t(scene, engine))).not.toThrow();
        const [, rollback] = transaction;
        expect((material as Material & { _renderFeatures?: unknown })._renderFeatures).toBeUndefined();

        rollback();
        expect((material as Material & { _linearImageProcessing?: boolean })._linearImageProcessing).toBe(false);
        expect((material as Material & { _renderFeatures?: unknown })._renderFeatures).toBe(features);
    });

    it("abandons delayed thin materialization when the material is cleared", async () => {
        const builder = vi.fn(async () => ({ renderables: [], rebuildSingle: (_scene: SceneContext, mesh: Mesh) => renderable(mesh) })) as unknown as MeshGroupBuilder;
        builder._materialFamily = "standard";
        const mesh = { material: { _buildGroup: builder }, children: [] } as unknown as Mesh;
        const scene = createScene({} as EngineContext);
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        setThinInstances(mesh, new Float32Array(16), 1);

        const pending = mesh._runtimeThinBuild!(scene, mesh);
        (mesh as unknown as { material: Material | null }).material = null;
        await pending;

        expect(builder).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });

    it("waits for every thin-instance runtime build started by one swap drain", async () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        scene._built = true;
        const starts: Array<Promise<void>> = [];
        const finishes: Array<() => void> = [];

        for (let i = 0; i < 2; i++) {
            let start!: () => void;
            let finish!: () => void;
            starts.push(new Promise<void>((resolve) => (start = resolve)));
            const done = new Promise<void>((resolve) => (finish = resolve));
            finishes.push(finish);
            const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
                start();
                await done;
                const rebuild = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
                return { renderables: meshes.map(renderable), rebuildSingle: rebuild };
            }) as MeshGroupBuilder;
            builder._materialFamily = "standard";
            const mesh = { _gpu: {}, material: { _buildGroup: builder } as Material, children: [] } as unknown as Mesh;
            setThinInstances(mesh, new Float32Array(16), 1);
            addToScene(scene, mesh);
            scene._materialSwapQueue.push(mesh);
        }

        let settled = false;
        const pending = (processMaterialSwaps(scene) as Promise<void>).then(() => (settled = true));
        await starts[0];

        finishes[0]!();
        await starts[1];
        expect(settled).toBe(false);

        finishes[1]!();
        await pending;
        expect(settled).toBe(true);
    });

    it("keeps the runtime dispatcher on the scene group instead of the shared builder", async () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        const base = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
        const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
            const rebuild = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
            builder._rebuildSingle = rebuild;
            return { renderables: meshes.map(renderable), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        builder._rebuildSingle = base;
        const material = { _buildGroup: builder } as Material;
        const mesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        setThinInstances(mesh, new Float32Array(16), 1);
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = base;
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);

        await startRuntimeMeshBuild(scene, builder, mesh);

        expect(builder._rebuildSingle).toBe(base);
        expect(Object.getOwnPropertyDescriptor(builder, "_rebuildSingle")?.get).toBeUndefined();
        expect(group.r).not.toBe(base);
        expect(mesh._runtimeThinBuild).toBeTypeOf("function");
    });

    it("deduplicates stable cleanup references without dropping distinct closures", async () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        const stableCleanup = vi.fn();
        const firstClosure = (): void => undefined;
        let secondClosure!: () => void;
        const base = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
        const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
            secondClosure = (): void => undefined;
            scene._disposables.push(stableCleanup, secondClosure);
            return { renderables: meshes.map(renderable), rebuildSingle: base };
        }) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        builder._rebuildSingle = base;
        const mesh = { _gpu: {}, material: { _buildGroup: builder } as Material, children: [] } as unknown as Mesh;
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = base;
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);
        scene._disposables.push(stableCleanup, firstClosure);

        await startRuntimeMeshBuild(scene, builder, mesh);

        expect(scene._disposables.filter((dispose) => dispose === stableCleanup)).toHaveLength(1);
        expect(scene._disposables).toContain(firstClosure);
        expect(scene._disposables).toContain(secondClosure);
    });

    it("serializes a synchronous material rebuild behind an active runtime mesh build", async () => {
        const engine = { _retirements: [] } as unknown as EngineContext;
        const scene = createScene(engine);
        const oldDispose = vi.fn();
        let standardBuilds = 0;
        const standardBuilder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            const dispose = standardBuilds++ === 0 ? oldDispose : vi.fn();
            const rebuild = (target: SceneContext, mesh: Mesh): Renderable => {
                target._meshDisposables.set(mesh, [dispose]);
                return renderable(mesh);
            };
            return { renderables: meshes.map((mesh) => rebuild(ctx, mesh)), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        standardBuilder._materialFamily = "standard";

        let startBuild!: () => void;
        let finishBuild!: () => void;
        const started = new Promise<void>((resolve) => (startBuild = resolve));
        const finish = new Promise<void>((resolve) => (finishBuild = resolve));
        const lateBuilder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            startBuild();
            await finish;
            const rebuild = (target: SceneContext, mesh: Mesh): Renderable => {
                target._meshDisposables.set(mesh, [vi.fn()]);
                return renderable(mesh);
            };
            return { renderables: meshes.map((mesh) => rebuild(ctx, mesh)), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        lateBuilder._materialFamily = "standard";

        const standardMaterial = { _buildGroup: standardBuilder } as Material;
        const lateMaterial = { _buildGroup: lateBuilder } as Material;
        const standardMesh = { _gpu: {}, material: standardMaterial, children: [] } as unknown as Mesh;
        const lateMesh = { _gpu: {}, material: lateMaterial, children: [] } as unknown as Mesh;
        setThinInstances(lateMesh, new Float32Array(16), 1);

        addToScene(scene, standardMesh);
        await buildScene(scene);
        addToScene(scene, lateMesh);
        const pending = processMaterialSwaps(scene) as Promise<void>;
        await started;

        rebuildMaterial(scene, standardMaterial);
        expect(oldDispose).not.toHaveBeenCalled();

        finishBuild();
        await pending;
        await vi.waitFor(() => expect(scene._runtimeBuilds?.w).toBe(false));
        engine._retirements?.splice(0).forEach((retire) => retire());
        expect(oldDispose).toHaveBeenCalledOnce();
    });

    it("reports an asynchronous material rebuild failure", async () => {
        const failure = new Error("async material rebuild failed");
        const report = vi.fn();
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const scene = createScene({} as EngineContext);
        scene._built = true;
        scene._runtimeBuilds = {
            w: true,
            queue: () => Promise.resolve(),
            _e: () => {
                throw failure;
            },
            _x: report,
        } as unknown as RuntimeSceneBuildHooks;
        const builder = (() => Promise.resolve({ renderables: [], rebuildSingle: (_target: SceneContext, target: Mesh) => renderable(target) })) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        const material = { _buildGroup: builder } as Material;
        const mesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        scene.meshes.push(mesh);

        rebuildMaterial(scene, material);

        await vi.waitFor(() => expect(report).toHaveBeenCalledWith(failure));
        expect(log).toHaveBeenCalledWith(failure);
        log.mockRestore();
    });

    it("invalidates cached material render features before rebuilding", () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        const builder = (async () => ({ renderables: [], rebuildSingle: (_target: SceneContext, target: Mesh) => renderable(target) })) as MeshGroupBuilder;
        const material = { _buildGroup: builder, _renderFeatures: { features: 0, features2: 0 } } as Material & { _renderFeatures?: unknown };

        rebuildMaterial(scene, material);

        expect(material._renderFeatures).toBeUndefined();
    });

    it("routes a PBR material swap that gains gamma albedo through the asynchronous scene rebuild", async () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        scene._built = true;
        const staleGammaRebuild = vi.fn((_target: SceneContext, target: Mesh): Renderable => {
            if ((target.material as Material & { gammaAlbedo?: boolean }).gammaAlbedo) {
                throw new Error("stale PBR gamma template");
            }
            return renderable(target);
        });
        const rebuiltMeshes: Mesh[] = [];
        const builder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            const rebuild = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
            for (const mesh of meshes) {
                rebuiltMeshes.push(mesh);
                ctx._meshDisposables.set(mesh, [vi.fn()]);
            }
            return { renderables: meshes.map(renderable), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        const initialMaterial = { _buildGroup: builder, gammaAlbedo: false } as Material & { gammaAlbedo: boolean };
        const gammaMaterial = { _buildGroup: builder, gammaAlbedo: true } as Material & { gammaAlbedo: boolean };
        const mesh = { _gpu: {}, material: initialMaterial, children: [] } as unknown as Mesh;
        const group = [mesh] as SceneMeshGroup;
        group.r = staleGammaRebuild;
        group._w = (target) => !!(target.material as (Material & { gammaAlbedo?: boolean }) | null)?.gammaAlbedo;
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);
        scene._renderables.push(renderable(mesh));
        mesh.material = gammaMaterial;
        scene._materialSwapQueue.push(mesh);

        const pending = processMaterialSwaps(scene) as Promise<void>;

        expect(staleGammaRebuild).not.toHaveBeenCalled();
        await pending;
        // Assert the runtime build system actually engaged. Without these the test would still pass if
        // `processMaterialSwaps` simply skipped the mesh: the stale closure would be uncalled and the
        // original renderable would still be in place.
        expect(scene._runtimeBuilds).toBeDefined();
        expect(scene._groups.get(builder)!.r).not.toBe(staleGammaRebuild);
        expect(rebuiltMeshes).toEqual([mesh]);
        expect(scene._renderables).toHaveLength(1);
        expect(scene._renderables[0]!.mesh).toBe(mesh);
    });

    it("chains gamma widening behind prior async work and skips stale material changes", async () => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        scene._built = true;
        let finishPrior!: () => void;
        let priorDone = false;
        const prior = new Promise<void>((resolve) => {
            finishPrior = () => {
                priorDone = true;
                resolve();
            };
        });
        const rebuiltMeshes: Mesh[] = [];
        const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
            rebuiltMeshes.push(...meshes);
            return { renderables: meshes.map(renderable), rebuildSingle: (_target: SceneContext, mesh: Mesh) => renderable(mesh) };
        }) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        const gammaMaterial = { _buildGroup: builder, gammaAlbedo: true } as Material & { gammaAlbedo: boolean };
        const replacementMaterial = { _buildGroup: builder, gammaAlbedo: false } as Material & { gammaAlbedo: boolean };
        const thinMesh = { _gpu: {}, material: replacementMaterial, children: [], _runtimeThinBuild: () => prior } as unknown as Mesh;
        const mesh = { _gpu: {}, material: gammaMaterial, children: [] } as unknown as Mesh;
        const group = [mesh] as SceneMeshGroup;
        group.r = (_target, target) => renderable(target);
        group._w = (target) => !!(target.material as (Material & { gammaAlbedo?: boolean }) | null)?.gammaAlbedo;
        scene.meshes.push(thinMesh, mesh);
        scene._groups.set(builder, group);
        scene._materialSwapQueue.push(thinMesh, mesh);

        const pending = processMaterialSwaps(scene) as Promise<void>;
        mesh.material = replacementMaterial;
        finishPrior();
        await pending;

        expect(priorDone).toBe(true);
        expect(rebuiltMeshes).toEqual([]);
    });

    it("disposes old PBR resources directly when a rebuild finishes after scene disposal", async () => {
        const engine = { _retirements: [] } as unknown as EngineContext;
        const scene = createScene(engine);
        scene._built = true;
        const oldDispose = vi.fn();
        const builtDispose = vi.fn();
        let startBuild!: () => void;
        let finishBuild!: () => void;
        const started = new Promise<void>((resolve) => (startBuild = resolve));
        const finish = new Promise<void>((resolve) => (finishBuild = resolve));
        const builder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            startBuild();
            await finish;
            const rebuild = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
            for (const mesh of meshes) {
                ctx._meshDisposables.set(mesh, [builtDispose]);
            }
            return { renderables: meshes.map(renderable), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        builder._materialFamily = "pbr";
        const material = { _buildGroup: builder } as Material;
        const mesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = (_ctx, target) => renderable(target);
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);
        scene._meshDisposables.set(mesh, [oldDispose]);

        const rebuild = rebuildScenePbrPipelines(scene);
        await started;
        scene._z = true;
        finishBuild();
        await rebuild;

        expect(builtDispose).toHaveBeenCalledOnce();
        expect(oldDispose).toHaveBeenCalledOnce();
        expect(engine._retirements).toHaveLength(0);
    });

    it.each(["resolve", "reject"] as const)("handles a material cleared while a PBR rebuild will %s", async (outcome) => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        scene._built = true;
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => (finish = resolve));
        const failure = new Error("PBR rebuild failed");
        const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
            await gate;
            if (outcome === "reject") {
                throw failure;
            }
            return { renderables: meshes.map(renderable), rebuildSingle: (_scene: SceneContext, mesh: Mesh) => renderable(mesh) };
        }) as MeshGroupBuilder;
        builder._materialFamily = "pbr";
        const material = { _buildGroup: builder } as Material;
        const mesh = { material, children: [] } as unknown as Mesh;
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = (_scene, target) => renderable(target);
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);

        const rebuild = rebuildScenePbrPipelines(scene);
        await vi.waitFor(() => expect(scene._runtimeBuilds?.w).toBe(true));
        (mesh as unknown as { material: Material | null }).material = null;
        finish();

        if (outcome === "reject") {
            await expect(rebuild).rejects.toBe(failure);
        } else {
            await expect(rebuild).resolves.toBeUndefined();
        }
    });

    it.each(["resolve", "reject"] as const)("updates a PBR gamma widening hook only when a rebuild will %s", async (outcome) => {
        const scene = createScene({ _retirements: [] } as unknown as EngineContext);
        scene._built = true;
        const failure = new Error("PBR rebuild failed");
        const builder = (async (_ctx: SceneContext, meshes: Mesh[]) => {
            if (outcome === "reject") {
                throw failure;
            }
            return { renderables: meshes.map(renderable), rebuildSingle: (_scene: SceneContext, mesh: Mesh) => renderable(mesh) };
        }) as MeshGroupBuilder;
        builder._materialFamily = "pbr";
        const material = { _buildGroup: builder, gammaAlbedo: true } as Material & { gammaAlbedo: boolean };
        const mesh = { material, children: [] } as unknown as Mesh;
        const group = [mesh] as SceneMeshGroup;
        const widen = (target: Mesh): boolean => !!(target.material as typeof material | null)?.gammaAlbedo;
        group.r = (_scene, target) => renderable(target);
        group._w = widen;
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);

        const rebuild = rebuildScenePbrPipelines(scene);

        if (outcome === "reject") {
            await expect(rebuild).rejects.toBe(failure);
            expect(group._w).toBe(widen);
        } else {
            await expect(rebuild).resolves.toBeUndefined();
            expect(group._w).toBeNull();
        }
    });

    it("detaches a merged packet before deferring its GPU disposer", async () => {
        const engine = { _retirements: [] } as unknown as EngineContext;
        const scene = createScene(engine);
        scene._built = true;
        const packet = { _disposed: false, _owner: [] as unknown[] };
        packet._owner.push(packet);
        const oldDispose = Object.assign(vi.fn(), { p: packet });
        const builder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            const rebuild = (_target: SceneContext, mesh: Mesh): Renderable => renderable(mesh);
            for (const mesh of meshes) {
                ctx._meshDisposables.set(mesh, [vi.fn()]);
            }
            return { renderables: meshes.map((mesh) => rebuild(ctx, mesh)), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        builder._materialFamily = "standard";
        const material = { _buildGroup: builder } as Material;
        const mesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = (_ctx, target) => renderable(target);
        scene.meshes.push(mesh);
        scene._groups.set(builder, group);
        scene._meshDisposables.set(mesh, [oldDispose]);
        scene._renderables.push({ order: 100, isTransparent: false } as Renderable);

        await startRuntimeMeshBuild(scene, builder, mesh);

        expect(packet._disposed).toBe(true);
        expect(packet._owner).toBeUndefined();
        expect(oldDispose).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);
    });
});
