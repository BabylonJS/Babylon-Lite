import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { rebuildMaterial } from "../../../packages/babylon-lite/src/material/material-rebuild";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import { rebuildScenePbrPipelines } from "../../../packages/babylon-lite/src/scene/scene-rebuild";
import { B } from "../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build";

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

        await B(scene, builder, mesh);

        expect(packet._disposed).toBe(true);
        expect(packet._owner).toBeUndefined();
        expect(oldDispose).not.toHaveBeenCalled();
        expect(engine._retirements).toHaveLength(1);
    });
});
