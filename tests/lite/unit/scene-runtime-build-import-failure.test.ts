import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { addToScene, buildScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { whenSceneBuildsComplete } from "../../../packages/babylon-lite/src/scene/scene-builds-complete";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";

// The runtime build chunk fails to load, e.g. a network error: its dynamic import rejects, so the
// runtime-build hooks (`_runtimeBuilds`) are never installed.
vi.mock("../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build", () => {
    throw new Error("runtime build chunk failed to load");
});

// Vitest wraps the factory's error in its own mocking error, which is what the rejected import carries.
const IMPORT_FAILURE = /error when mocking a module/;

function makeBuilder(): MeshGroupBuilder {
    const builder = (async (_scene: SceneContext, meshes: Mesh[]) => {
        const rebuildSingle = (_s: SceneContext, mesh: Mesh): Renderable => ({ mesh, order: 100, isTransparent: false }) as Renderable;
        builder._rebuildSingle = rebuildSingle;
        return { renderables: meshes.map((mesh) => rebuildSingle(_scene, mesh)), rebuildSingle };
    }) as MeshGroupBuilder;
    return builder;
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
    addToScene(scene, makeMesh(makeBuilder()));
    await buildScene(scene);
    return scene;
}

/** Runs the scene's before-render callbacks, as the next rendered frame does. */
function renderFrameCallbacks(scene: SceneContext): void {
    for (const callback of scene._beforeRender) {
        callback(0);
    }
}

describe("runtime build chunk that fails to load", () => {
    it("throws the failure from the next frame after a new material family was queued", async () => {
        const scene = await makeBuiltScene();
        addToScene(scene, makeMesh(makeBuilder()));

        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
        expect(scene._runtimeBuilds).toBeUndefined();

        expect(() => renderFrameCallbacks(scene)).toThrow(IMPORT_FAILURE);
        // Thrown once, like a build failure reported through the runtime-build hooks.
        expect(() => renderFrameCallbacks(scene)).not.toThrow();
    });

    it("throws the failure from the next frame for a thin-instance runtime build", async () => {
        const scene = await makeBuiltScene();
        const mesh = makeMesh(makeBuilder());
        setThinInstances(mesh, new Float32Array(16), 1);
        scene._materialSwapQueue.push(mesh);
        // The render loop's drain, which drops the promise.
        void processMaterialSwaps(scene);

        await expect(whenSceneBuildsComplete(scene)).resolves.toBeUndefined();
        expect(() => renderFrameCallbacks(scene)).toThrow(IMPORT_FAILURE);
    });
});
