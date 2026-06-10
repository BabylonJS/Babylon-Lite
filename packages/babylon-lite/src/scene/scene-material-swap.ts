import type { SceneContext } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): void {
    const q = scene._materialSwapQueue;
    const device = scene.engine._device;
    for (const mesh of q) {
        (mesh as Mesh)._materialDirty = false;
        const old = scene._meshDisposables.get(mesh);
        if (old) {
            scene._meshDisposables.delete(mesh);
            // These disposables free the OLD renderable's GPU resources (per-mesh/material UBOs, the
            // GPU-cull state buffers, texture releases). They must NOT run synchronously: the old buffers
            // may still be referenced by a frame already submitted to the GPU this tick, and destroying
            // them now hits the validation error "Buffer used in submit while destroyed" (seen when a
            // plugin / shadow-receiver variant change swaps a planted mesh's material — e.g. planting a
            // fern or agave). The new renderable is rebuilt below and replaces the old one, so nothing
            // records the old resources again; defer the teardown until the GPU has drained the
            // currently-submitted work (onSubmittedWorkDone). Mirrors resizeMeshGeometry.
            void device.queue
                .onSubmittedWorkDone()
                .then(() => {
                    try {
                        for (const fn of old) {
                            fn();
                        }
                    } catch {
                        // Device may have been lost/disposed before the deferred teardown ran.
                    }
                })
                .catch(() => {});
        }

        const mat = mesh.material;
        const builder = mat?._buildGroup;
        if (!builder) {
            continue;
        }
        const rebuild = builder._rebuildSingle;
        if (!rebuild) {
            continue;
        }
        const renderable = rebuild(scene, mesh);
        // Insert by `order` so the renderable list stays sorted (frame-graph
        // tasks bucket opaque/direct/transparent at bind time).
        let i = scene._renderables.length;
        while (i > 0 && scene._renderables[i - 1]!.order > renderable.order) {
            i--;
        }
        scene._renderables.splice(i, 0, renderable);
    }
    q.length = 0;
    scene._renderableVersion++;
}
