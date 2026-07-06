import type { SceneContext } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Renderable } from "../render/renderable.js";

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;

/**
 * Rebuild the PBR material group(s) of a scene in place, recompiling their pipelines.
 *
 * Needed after a scene-wide COMPILE-TIME PBR shader feature changes — tone mapping being
 * the first case. `rebuildMaterial` cannot do this: it reuses the per-scene composer
 * closure captured at build time (which already baked in the tone-mapping decision), so
 * it only rebuilds bind groups/pipelines from the SAME shader source. This re-runs the
 * group builder from scratch, so the scene-wide feature scan and WGSL composition run
 * again with the current `imageProcessing` configuration.
 *
 * Scoped to the PBR family (the only family whose shaders bake image-processing state).
 * PBR group builders return no scene-UBO updater, so none is re-registered here; if this
 * is ever generalized to families that own an updater, updater replacement must be added.
 *
 * No-op before the scene's initial build has run (nothing to rebuild yet).
 *
 * @param scene - The scene whose PBR pipelines should be rebuilt.
 */
export async function rebuildScenePbrPipelines(scene: SceneContext): Promise<void> {
    const ctx = scene;
    if (!ctx._built) {
        return;
    }

    let changed = false;
    for (const [builder, meshes] of ctx._groups) {
        if (builder._materialFamily !== "pbr" || meshes.length === 0) {
            continue;
        }

        // Tear down the group's existing per-mesh GPU state and remove its renderables.
        const meshSet = new Set<Mesh>(meshes);
        for (const mesh of meshes) {
            const disposers = ctx._meshDisposables.get(mesh);
            if (disposers) {
                for (const fn of disposers) {
                    fn();
                }
                ctx._meshDisposables.delete(mesh);
            }
        }
        for (let i = ctx._renderables.length - 1; i >= 0; i--) {
            if (meshSet.has(ctx._renderables[i]!.mesh as Mesh)) {
                ctx._renderables.splice(i, 1);
            }
        }

        // Re-run the builder — re-scans meshes for scene-wide features and recompiles pipelines.
        const result = await builder(ctx, meshes);
        builder._rebuildSingle = result.rebuildSingle;
        ctx._renderables.push(...result.renderables);
        changed = true;
    }

    if (changed) {
        ctx._renderables.sort(byOrder);
        ctx._renderableVersion++;
        ctx._materialEpoch++;
        ctx._frameGraph.build();
    }
}
