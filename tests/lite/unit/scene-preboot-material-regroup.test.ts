import { describe, expect, it, vi } from "vitest";

import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

// The Standard renderable build needs a GPU device; stand in for it so the real Standard group builder can run.
vi.mock("../../../packages/babylon-lite/src/material/standard/standard-renderable", () => ({
    buildStandardMeshRenderables: (_scene: SceneContext, meshes: Mesh[]) => {
        const rebuildSingle = (_s: SceneContext, mesh: Mesh): TaggedRenderable => ({ mesh, order: 100, isTransparent: false, tag: "standard" }) as TaggedRenderable;
        return { renderables: meshes.map((mesh) => rebuildSingle(_scene, mesh)), rebuildSingle };
    },
}));

type TaggedRenderable = Renderable & { tag: string };

/** Builder that, like the real material builders, requires at least one mesh. */
const createBuilder = (tag: string): MeshGroupBuilder => {
    const rebuildSingle = (_scene: SceneContext, mesh: Mesh): TaggedRenderable => ({ mesh, order: 100, isTransparent: false, tag }) as TaggedRenderable;
    return (async (scene: SceneContext, meshes: Mesh[]) => {
        if (!meshes[0]) {
            throw new Error(`builder "${tag}" invoked with no meshes`);
        }
        return { renderables: meshes.map((mesh) => rebuildSingle(scene, mesh)), rebuildSingle };
    }) as MeshGroupBuilder;
};

const createScene = (): SceneContext =>
    ({
        surface: { engine: { _retirements: [] } },
        meshes: [],
        lights: [],
        _groups: new Map(),
        _deferredBuilders: [],
        _renderables: [],
        _uniformUpdaters: [],
        _disposables: [],
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _renderableVersion: 0,
        _materialEpoch: 0,
        _built: false,
    }) as unknown as SceneContext;

const createMesh = (material: Material | null): Mesh => ({ _gpu: {}, material, children: [] }) as unknown as Mesh;

const tagsFor = (scene: SceneContext, mesh: Mesh): string[] => scene._renderables.filter((r) => r.mesh === mesh).map((r) => (r as TaggedRenderable).tag);

describe("material assigned after addToScene but before the initial build", () => {
    it("builds a mesh that was added without a material", async () => {
        const scene = createScene();
        const mesh = createMesh(null);

        addToScene(scene, mesh);
        mesh.material = { _buildGroup: createBuilder("assigned") } as Material;
        await buildScene(scene);

        expect(tagsFor(scene, mesh)).toEqual(["assigned"]);
    });

    it("builds a re-materialed mesh with its new material family only", async () => {
        const scene = createScene();
        const initial = createBuilder("initial");
        const mesh = createMesh({ _buildGroup: initial } as Material);

        addToScene(scene, mesh);
        mesh.material = { _buildGroup: createBuilder("final") } as Material;
        await buildScene(scene);

        expect(tagsFor(scene, mesh)).toEqual(["final"]);
        expect(scene._groups.has(initial)).toBe(false);
    });

    it("builds a mesh once when re-materialed within the same family", async () => {
        const scene = createScene();
        const builder = createBuilder("shared");
        const mesh = createMesh({ _buildGroup: builder } as Material);

        addToScene(scene, mesh);
        mesh.material = { _buildGroup: builder } as Material;
        await buildScene(scene);

        expect(tagsFor(scene, mesh)).toEqual(["shared"]);
    });

    it("does not build a mesh whose material was cleared", async () => {
        const scene = createScene();
        const initial = createBuilder("cleared");
        const mesh = createMesh({ _buildGroup: initial } as Material);

        addToScene(scene, mesh);
        mesh.material = null as unknown as Material;
        await buildScene(scene);

        expect(tagsFor(scene, mesh)).toEqual([]);
        expect(scene._groups.has(initial)).toBe(false);
    });

    it("rebuilds a dropped family when a mesh rejoins it during the boot drain", async () => {
        const scene = createScene();
        const first = createBuilder("first");
        const mesh = createMesh({ _buildGroup: first } as Material);
        const late = createMesh({ _buildGroup: first } as Material);

        addToScene(scene, mesh);
        mesh.material = { _buildGroup: createBuilder("second") } as Material;
        // Lands after the emptied `first` group was dropped, like an async glTF load resolving mid-drain.
        scene._deferredBuilders.push(async () => {
            await Promise.resolve();
            addToScene(scene, late);
        });
        await buildScene(scene);

        expect(tagsFor(scene, mesh)).toEqual(["second"]);
        expect(tagsFor(scene, late)).toEqual(["first"]);
    });

    it("moves the sole PBR mesh to a StandardMaterial without building the emptied PBR group", async () => {
        const scene = createScene();
        const pbr = createPbrMaterial();
        const mesh = createMesh(pbr);

        addToScene(scene, mesh);
        mesh.material = createStandardMaterial();
        await expect(buildScene(scene)).resolves.toBeUndefined();

        expect(tagsFor(scene, mesh)).toEqual(["standard"]);
        expect(scene._groups.has(pbr._buildGroup)).toBe(false);
    });

    it("clears the sole PBR mesh's material without building the emptied PBR group", async () => {
        const scene = createScene();
        const pbr = createPbrMaterial();
        const mesh = createMesh(pbr);

        addToScene(scene, mesh);
        mesh.material = null as unknown as Material;
        await expect(buildScene(scene)).resolves.toBeUndefined();

        expect(tagsFor(scene, mesh)).toEqual([]);
        expect(scene._groups.has(pbr._buildGroup)).toBe(false);
    });
});
