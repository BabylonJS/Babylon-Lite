import type { SceneContext } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";

/** @internal Drain _materialSwapQueue: dispose old resources and rebuild renderables. */
export function processMaterialSwaps(scene: SceneContext): void {
    const q = scene._materialSwapQueue;
    for (const mesh of q) {
        (mesh as Mesh)._materialDirty = false;
        const old = scene._meshDisposables.get(mesh);
        if (old) {
            for (const fn of old) {
                fn();
            }
            scene._meshDisposables.delete(mesh);
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
