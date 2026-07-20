import type { SceneContext } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";

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

    const engine = ctx.surface.engine;

    let changed = false;
    for (const [builder, meshes] of ctx._groups) {
        if (builder._materialFamily !== "pbr" || meshes.length === 0) {
            continue;
        }

        // Capture the existing per-mesh teardown closures WITHOUT running them yet. The teardown
        // releases each material's refcounted GPU textures (and destroys the old per-mesh UBOs); running
        // it before the rebuild could drop a shared texture's refcount to zero and destroy it, leaving
        // the freshly built bind groups pointing at a destroyed texture ("Destroyed texture used in a
        // submit"). Instead we rebuild first (make-before-break): the builder re-acquires the same
        // textures, bumping their refcount, so running the old teardown afterwards nets no change and the
        // textures stay alive.
        const oldDisposers: Array<() => void> = [];
        const meshSet = new Set<Mesh>(meshes);
        for (const mesh of meshes) {
            const disposers = ctx._meshDisposables.get(mesh);
            if (disposers) {
                oldDisposers.push(...disposers);
            }
        }

        // Remove the group's existing renderables (the builder produces fresh ones).
        for (let i = ctx._renderables.length - 1; i >= 0; i--) {
            if (meshSet.has(ctx._renderables[i]!.mesh as Mesh)) {
                ctx._renderables.splice(i, 1);
            }
        }

        // Re-run the builder — re-scans meshes for scene-wide features, recompiles pipelines, and
        // overwrites each mesh's _meshDisposables with fresh teardown closures (re-acquiring textures).
        const result = await builder(ctx, meshes);
        builder._rebuildSingle = result.rebuildSingle;
        ctx._renderables.push(...result.renderables);

        // Tear down the OLD per-mesh GPU state now that the rebuild is complete: destroys the old UBOs
        // (no longer referenced by the new bind groups) and releases the textures the builder just
        // re-acquired, so shared textures' refcounts return to their pre-rebuild value and stay alive.
        //
        // This must NOT run synchronously: the old per-mesh/material UBOs may still be referenced by a
        // next frame command buffer, and destroying them now hits the WebGPU validation error
        // "Buffer used in submit while destroyed". Retire after that frame submits and drains, mirroring
        // processMaterialSwaps. The make-before-break
        // refcount invariant holds across the defer: the builder already re-acquired the shared textures
        // (refcount bumped), so they stay alive until the deferred release nets the refcount back down.
        retireGpuResources(engine, () => {
            for (const fn of oldDisposers) {
                fn();
            }
        });

        changed = true;
    }

    if (changed) {
        ctx._renderables.sort(byOrder);
        ctx._renderableVersion++;
        ctx._materialEpoch++;
        ctx._frameGraph.build();
    }
}
