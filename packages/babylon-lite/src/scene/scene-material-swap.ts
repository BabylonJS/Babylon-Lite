import type { SceneContext, SceneContextInternal } from "./scene-core.js";
import type { MeshInternal } from "../mesh/mesh.js";

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): void {
    const ctx = scene as SceneContextInternal;
    const q = ctx._materialSwapQueue;
    for (const mesh of q) {
        (mesh as MeshInternal)._materialDirty = false;
        const old = ctx._meshDisposables.get(mesh);
        if (old) {
            for (const fn of old) {
                fn();
            }
            ctx._meshDisposables.delete(mesh);
        }

        const mat = mesh.material;
        const builder = mat ? (mat as any)._buildGroup : undefined;
        if (!builder) {
            continue;
        }
        const rebuild = builder._rebuildSingle;
        if (!rebuild) {
            continue;
        }
        const renderable = rebuild(ctx, mesh);
        // Insert by `order` so the renderable list stays sorted (frame-graph
        // tasks bucket transparency/transmissive at bind time).
        let i = ctx._renderables.length;
        while (i > 0 && ctx._renderables[i - 1]!.order > renderable.order) {
            i--;
        }
        ctx._renderables.splice(i, 0, renderable);
    }
    q.length = 0;
    ctx._renderableVersion++;
}
