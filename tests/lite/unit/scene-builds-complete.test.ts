import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { whenSceneBuildsComplete } from "../../../packages/babylon-lite/src/scene/scene-builds-complete";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";

/** A group builder whose builds the test releases by hand (`gated`), or that builds at once. */
function makeBuilder(gated = false) {
    const releases: (() => void)[] = [];
    const builder = (async (_scene: SceneContext, meshes: Mesh[]) => {
        if (gated) {
            await new Promise<void>((resolve) => releases.push(resolve));
        }
        const rebuildSingle = (_s: SceneContext, mesh: Mesh): Renderable => ({ mesh, order: 100, isTransparent: false }) as Renderable;
        builder._rebuildSingle = rebuildSingle;
        return { renderables: meshes.map((mesh) => rebuildSingle(_scene, mesh)), rebuildSingle };
    }) as MeshGroupBuilder;
    return {
        builder,
        releaseAll: () => releases.splice(0).forEach((release) => release()),
        pendingBuilds: () => releases.length,
    };
}

function makeMesh(builder: MeshGroupBuilder): Mesh {
    return { _gpu: {}, material: { _buildGroup: builder } as Material, children: [] } as unknown as Mesh;
}

async function makeBuiltScene(): Promise<SceneContext> {
    const scene = {
        surface: { engine: { _retirements: [] } as unknown as EngineContext },
        meshes: [],
        lights: [],
        _groups: new Map(),
        _deferredBuilders: [],
        _renderables: [],
        _uniformUpdaters: [],
        _beforeRender: [],
        _disposables: [],
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _renderableVersion: 0,
        _materialEpoch: 0,
        _built: false,
    } as unknown as SceneContext;
    addToScene(scene, makeMesh(makeBuilder().builder));
    await buildScene(scene);
    return scene;
}

function rendered(scene: SceneContext, mesh: Mesh): boolean {
    return scene._renderables.some((renderable) => renderable.mesh === mesh);
}

describe("whenSceneBuildsComplete", () => {
    it("resolves at once when nothing is pending", async () => {
        const scene = await makeBuiltScene();
        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
    });

    it("starts the build of a mesh queued after registration and waits for it, without a frame", async () => {
        const scene = await makeBuiltScene();
        const late = makeBuilder(true);
        const mesh = makeMesh(late.builder);
        addToScene(scene, mesh);

        const done = vi.fn();
        const waiting = whenSceneBuildsComplete(scene).then(done);
        await vi.waitFor(() => expect(late.pendingBuilds()).toBe(1));
        expect(done).not.toHaveBeenCalled();
        expect(rendered(scene, mesh)).toBe(false);

        late.releaseAll();
        await waiting;
        expect(rendered(scene, mesh)).toBe(true);
        expect(scene._materialSwapQueue).toHaveLength(0);
    });

    it("waits for a build the frame drain started before the runtime build module was loaded", async () => {
        const scene = await makeBuiltScene();
        const late = makeBuilder(true);
        const mesh = makeMesh(late.builder);
        addToScene(scene, mesh);
        // What the render loop does: drain the queue and drop the promise.
        void processMaterialSwaps(scene);

        const done = vi.fn();
        const waiting = whenSceneBuildsComplete(scene).then(done);
        await vi.waitFor(() => expect(late.pendingBuilds()).toBe(1));
        expect(done).not.toHaveBeenCalled();

        late.releaseAll();
        await waiting;
        expect(rendered(scene, mesh)).toBe(true);
    });

    it("waits for builds started while it is waiting", async () => {
        const scene = await makeBuiltScene();
        const first = makeBuilder(true);
        const second = makeBuilder(true);
        const firstMesh = makeMesh(first.builder);
        const secondMesh = makeMesh(second.builder);
        addToScene(scene, firstMesh);

        const done = vi.fn();
        const waiting = whenSceneBuildsComplete(scene).then(done);
        await vi.waitFor(() => expect(first.pendingBuilds()).toBe(1));
        addToScene(scene, secondMesh);
        void processMaterialSwaps(scene);

        first.releaseAll();
        await vi.waitFor(() => expect(second.pendingBuilds()).toBe(1));
        expect(done).not.toHaveBeenCalled();

        second.releaseAll();
        await waiting;
        expect(rendered(scene, firstMesh)).toBe(true);
        expect(rendered(scene, secondMesh)).toBe(true);
    });

    it("resolves when a build fails and leaves the error to the next frame", async () => {
        const scene = await makeBuiltScene();
        const failing = (async () => {
            throw new Error("runtime build failed");
        }) as unknown as MeshGroupBuilder;
        addToScene(scene, makeMesh(failing));

        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
        expect(() => scene._beforeRender.forEach((callback) => callback(0))).toThrow("runtime build failed");
    });

    it("leaves a rebuild that throws while draining the queue to the next frame", async () => {
        const scene = await makeBuiltScene();
        const [mesh] = scene.meshes as Mesh[];
        // The mesh's group is already built, so the drain rebuilds it synchronously through this closure.
        scene._groups.get(mesh!.material!._buildGroup)!.r = () => {
            throw new Error("rebuild failed");
        };
        scene._materialSwapQueue.push(mesh!);

        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
        // Still queued, so the next frame's drain throws the same error, as with continuous rendering.
        expect(scene._materialSwapQueue).toEqual([mesh]);
        expect(() => processMaterialSwaps(scene)).toThrow("rebuild failed");
    });

    it("does not build before registration", async () => {
        const scene = {
            _built: false,
            _materialSwapQueue: [makeMesh(makeBuilder().builder)],
        } as unknown as SceneContext;
        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
        expect(scene._materialSwapQueue).toHaveLength(1);
    });
});
