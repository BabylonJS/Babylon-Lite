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
        if (rebuild) {
            const renderable = rebuild(ctx, mesh);
            if (renderable.isTransparent) {
                ctx._transparentRenderables.push(renderable);
            } else {
                const arr = renderable.isTransmissive ? ctx._transmissiveRenderables : ctx._opaqueRenderables;
                let i = arr.length;
                while (i > 0 && arr[i - 1]!.order > renderable.order) {
                    i--;
                }
                arr.splice(i, 0, renderable);
            }
        } else if (builder._loadRebuildSingle) {
            builder._loadRebuildSingle().then((mod: any) => {
                builder._rebuildSingle = mod.buildSinglePbrRenderable ?? mod.buildSingleStandardRenderable;
                (mesh as MeshInternal)._materialDirty = true;
                ctx._materialSwapQueue.push(mesh);
            });
        }
    }
    q.length = 0;
    ctx._renderableVersion++;
}
