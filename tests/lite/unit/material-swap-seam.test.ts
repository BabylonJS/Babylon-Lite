/**
 * Lazy material-swap drain seam.
 *
 * `scene-core` no longer imports `processMaterialSwaps` statically: `enqueueMaterialSwap` installs
 * the drain on the scene the first time one is queued, so a scene that never re-materials a mesh
 * keeps `scene-material-swap.js` out of its bundle entirely.
 */
import { describe, expect, it, vi } from "vitest";

import { enqueueMaterialSwap } from "../../../packages/babylon-lite/src/scene/mesh-scene-registry";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

function fakeScene(): SceneContext {
    return { _materialSwapQueue: [] } as unknown as SceneContext;
}

const mesh = (): Mesh => ({}) as unknown as Mesh;

describe("material-swap drain seam", () => {
    it("installs the drain on the first enqueue only", () => {
        const scene = fakeScene();
        expect(scene._drainSwaps).toBeUndefined();

        enqueueMaterialSwap(scene, mesh());
        const installed = scene._drainSwaps;
        expect(installed).toBeTypeOf("function");

        enqueueMaterialSwap(scene, mesh());
        expect(scene._drainSwaps).toBe(installed); // same seam, not reinstalled
        expect(scene._materialSwapQueue).toHaveLength(2);
    });

    it("dedupes a mesh already queued", () => {
        const scene = fakeScene();
        const m = mesh();
        enqueueMaterialSwap(scene, m);
        enqueueMaterialSwap(scene, m);
        expect(scene._materialSwapQueue).toHaveLength(1);
    });

    it("latches the in-flight load so repeated frames do not start a second import", async () => {
        const scene = fakeScene();
        enqueueMaterialSwap(scene, mesh());
        const drain = scene._drainSwaps!;

        // The render loop calls the seam on every frame the queue is non-empty.
        const first = drain(scene);
        const second = drain(scene);
        expect(second).toBe(first);

        await first;
        // Once loaded, the seam is replaced by the real implementation: later drains are synchronous.
        expect(scene._drainSwaps).not.toBe(drain);
        expect(scene._drainSwaps).toBeTypeOf("function");
    });

    it("drains through the installed implementation after the load", async () => {
        const scene = fakeScene();
        enqueueMaterialSwap(scene, mesh());
        await scene._drainSwaps!(scene);

        // A mesh with no material is skipped by the drain, but the queue is still cleared — the point
        // here is that the seam resolved to the real `processMaterialSwaps` rather than a stub.
        expect(scene._materialSwapQueue).toHaveLength(0);
    });

    it("keeps the mirrored-meshes opt-in on a synchronous drain from the first flip", async () => {
        const scene = fakeScene();
        (scene as unknown as { _beforeRender: unknown[]; meshes: unknown[] })._beforeRender = [];
        (scene as unknown as { meshes: unknown[] }).meshes = [];
        const { enableMirroredMeshes } = await import("../../../packages/babylon-lite/src/mesh/enable-mirrored-meshes");
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await enableMirroredMeshes(scene);

        // The watcher rebuilds on a determinant flip and the pipeline's frontFace is already wrong by
        // then, so the drain must be in place before the first enqueue — not fetched by it.
        expect(scene._drainSwaps).toBeTypeOf("function");
        const beforeEnqueue = scene._drainSwaps;
        enqueueMaterialSwap(scene, mesh());
        expect(scene._drainSwaps).toBe(beforeEnqueue);
    });
});
