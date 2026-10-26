import type { SceneContext, SceneMeshGroup } from "./scene-core.js";
import { enqueueMaterialSwap } from "./mesh-scene-registry.js";
import { removeEvery, retireMeshTeardown } from "./scene-remove.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshGroupBuilder, MeshGroupBuildResult, Renderable } from "../render/renderable.js";

/** Builds of one boot or recovery group before membership that keeps changing is handed to the swap drain. */
const MAX_GROUP_BUILD_ATTEMPTS = 3;

/** Drop what an in-flight group build produced for a mesh that was removed or detached while the build
 *  awaited: removal found nothing to tear down then, and the builder installed it afterwards. */
function evictBuiltMesh(scene: SceneContext, mesh: Mesh, renderables: Renderable[]): void {
    const teardown = scene._meshDisposables.get(mesh);
    if (teardown) {
        scene._meshDisposables.delete(mesh);
        retireMeshTeardown(scene, teardown);
    }
    removeEvery(renderables, (renderable) => renderable.mesh === mesh);
}

/** @internal Revalidate a settled boot or recovery group build whose membership changed while it awaited.
 *  Loaded by `buildGroupSnapshot` only when the membership actually changed, so removal outside a build pays
 *  only for the unchanged-group comparison.
 *
 *  Only a member that left is fixed up in place, by evicting its per-mesh output, and only a mesh that joined
 *  is deferred to the swap drain. The build is obsolete, and is retried against the group's current sequence,
 *  when:
 *  - the surviving members changed relative order (a detach and reinsertion): transparent ties follow
 *    admission order, so the output must match a fresh build of the current sequence;
 *  - a member left and the output merged it into a renderable without a `mesh` back-reference, which would
 *    keep drawing it; or
 *  - a member left and the build threw: it may have read a material the mesh was given after leaving,
 *    which can belong to another family. A failure that persists without a membership change is rethrown.
 *
 *  Per-mesh resources of an obsolete build are retired only after the replacement build (make-before-break,
 *  so shared textures it re-acquires never reach a zero refcount). Scene-level resources an obsolete build
 *  registered stay owned by the scene until it is disposed. A group that empties is abandoned and dropped,
 *  as is one that keeps changing: its remaining members are queued for the material-swap drain, which builds
 *  a group without a completed build through the runtime path.
 *
 *  A `stale` build read the live group instead of a snapshot, so it may have skipped or included members as
 *  they left or joined mid-iteration: it is always obsolete, and the output of current members is retired too. */
export async function settleGroupBuild(
    scene: SceneContext,
    build: MeshGroupBuilder,
    group: SceneMeshGroup,
    members: Mesh[],
    pending: Promise<MeshGroupBuildResult>,
    stale: boolean
): Promise<MeshGroupBuildResult | undefined> {
    let result: MeshGroupBuildResult | undefined;
    let error: unknown;
    try {
        result = await pending;
    } catch (thrown) {
        error = thrown;
    }
    const superseded: (() => void)[] = [];
    try {
        for (let attempt = 1; ; attempt++) {
            const captured = new Set(members);
            const live = new Set(group);
            const surviving = members.filter((mesh) => live.has(mesh));
            let next = 0;
            const reordered = group.some((mesh) => captured.has(mesh) && mesh !== surviving[next++]);
            const left = surviving.length !== members.length;
            if (!stale && !reordered && !(left && (!result || result.renderables.some((renderable) => !renderable.mesh)))) {
                if (!result) {
                    throw error;
                }
                for (const mesh of members) {
                    if (!live.has(mesh)) {
                        evictBuiltMesh(scene, mesh, result.renderables);
                    }
                }
                for (const mesh of group) {
                    if (!captured.has(mesh)) {
                        enqueueMaterialSwap(scene, mesh);
                    }
                }
                return result;
            }
            for (const mesh of stale ? members.concat(group) : members) {
                const teardown = scene._meshDisposables.get(mesh);
                if (teardown) {
                    scene._meshDisposables.delete(mesh);
                    superseded.push(...teardown);
                }
            }
            stale = false;
            if (scene._z || !group.length || attempt >= MAX_GROUP_BUILD_ATTEMPTS) {
                if (!group.length && scene._groups.get(build) === group) {
                    scene._groups.delete(build);
                }
                if (!scene._z) {
                    for (const mesh of group) {
                        enqueueMaterialSwap(scene, mesh);
                    }
                }
                return undefined;
            }
            members = group.slice();
            result = undefined;
            try {
                result = await build(scene, members);
            } catch (thrown) {
                error = thrown;
            }
        }
    } finally {
        if (superseded.length) {
            retireMeshTeardown(scene, superseded);
        }
    }
}
