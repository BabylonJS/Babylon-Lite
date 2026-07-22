import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";

describe("scene material swap", () => {
    it("replaces every old renderable for the mesh before retiring its GPU resources", () => {
        const retirements: Array<() => void> = [];
        const disposeOld = vi.fn();
        const mesh = {} as Mesh;
        const oldMain = { mesh, order: 100 } as Renderable;
        const oldDuplicate = { mesh, order: 101 } as Renderable;
        const other = { mesh: {} as Mesh, order: 50 } as Renderable;
        const replacement = { mesh, order: 75 } as Renderable;
        const material = {
            _buildGroup: {
                _rebuildSingle: vi.fn(() => replacement),
            },
        } as unknown as Material;
        mesh.material = material;
        const group = [mesh] as Mesh[] & { r?: NonNullable<MeshGroupBuilder["_rebuildSingle"]> };
        group.r = material._buildGroup._rebuildSingle;
        const engine = {
            _retirements: retirements,
        } as unknown as EngineContext;
        const scene = {
            surface: { engine },
            _materialSwapQueue: [mesh],
            _groups: new Map([[material._buildGroup, group]]),
            _meshDisposables: new Map([[mesh, [disposeOld]]]),
            _renderables: [other, oldMain, oldDuplicate],
            _renderableVersion: 4,
            _materialEpoch: 2,
        } as unknown as SceneContext;

        processMaterialSwaps(scene);

        expect(scene._renderables).toEqual([other, replacement]);
        expect(scene._renderables.filter((renderable) => renderable.mesh === mesh)).toEqual([replacement]);
        expect(disposeOld).not.toHaveBeenCalled();
        expect(retirements).toHaveLength(1);
    });

    it("skips a queued mesh until its material group exposes a rebuild closure", () => {
        const disposeOld = vi.fn();
        const mesh = {
            material: { _buildGroup: {} },
        } as unknown as Mesh;
        const scene = {
            surface: { engine: { _retirements: [] } },
            _materialSwapQueue: [mesh],
            _meshDisposables: new Map([[mesh, [disposeOld]]]),
            _renderables: [],
            _renderableVersion: 0,
            _materialEpoch: 0,
        } as unknown as SceneContext;

        expect(() => processMaterialSwaps(scene)).not.toThrow();
        expect(disposeOld).not.toHaveBeenCalled();
        expect(scene._materialSwapQueue).toHaveLength(0);
        expect(scene._renderableVersion).toBe(0);
        expect(scene._materialEpoch).toBe(0);
    });

    it("rescans a material group when a runtime-added mesh introduces thin instances", async () => {
        type TestRenderable = Renderable & { usesThinInstances: boolean };

        const engine = {
            _retirements: [],
        } as unknown as EngineContext;
        const scene = {
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
            _builtGroups: new Set(),
            _renderableVersion: 0,
            _materialEpoch: 0,
            _built: false,
        } as unknown as SceneContext;

        const builder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            const supportsThinInstances = meshes.some((mesh) => !!mesh.thinInstances);
            const rebuildSingle = (_scene: SceneContext, mesh: Mesh): TestRenderable =>
                ({
                    mesh,
                    order: 100,
                    isTransparent: false,
                    usesThinInstances: supportsThinInstances,
                }) as TestRenderable;
            builder._rebuildSingle = rebuildSingle;
            return {
                renderables: meshes.map((mesh) => rebuildSingle(ctx, mesh)),
                rebuildSingle,
            };
        }) as MeshGroupBuilder;
        const material = { _buildGroup: builder } as Material;
        const plainMesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        const instancedMesh = { _gpu: {}, material, children: [] } as unknown as Mesh;
        setThinInstances(instancedMesh, new Float32Array(16), 1);

        addToScene(scene, plainMesh);
        await buildScene(scene);

        addToScene(scene, instancedMesh);
        processMaterialSwaps(scene);

        await vi.waitFor(() => {
            const renderable = scene._renderables.find((candidate) => candidate.mesh === instancedMesh) as TestRenderable | undefined;
            expect(renderable?.usesThinInstances).toBe(true);
        });
    });
});
