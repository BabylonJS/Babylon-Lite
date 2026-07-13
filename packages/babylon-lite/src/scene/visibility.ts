/** Mesh/node visibility toggle. Public entry point is `setMeshVisible`
 *  (barrel-exported); also used internally by the KHR_node_visibility loader
 *  and KHR_animation_pointer writer.
 *
 *  This helper is the sole place that bumps the module-scoped visibility
 *  epoch (see `visibility-epoch.ts`). The bump invalidates the cached opaque
 *  render bundle so a hidden mesh actually stops drawing — a bare
 *  `node.visible = …` field write does NOT, by design, so the hot SceneNode
 *  write path stays a plain field assignment and bundle invalidation is O(1). */

import type { SceneNode } from "./scene-node.js";
import { bumpVisibilityEpoch } from "../engine/engine.js";

/** Set `visible` on `node` and all descendants (via `node.children`). glTF
 *  KHR_node_visibility specifies that children inherit their parent's
 *  invisibility — we materialize this at set-time so the render hot-path
 *  only has to check a single boolean per mesh.
 *
 *  The epoch bump is SKIPPED when no node's flag actually changed: the bump
 *  re-records every cached opaque render bundle (each draw re-resolves its
 *  pipeline), so an animation loop that re-asserts the same visibility every
 *  frame would otherwise force a full re-record per frame scene-wide. A
 *  same-value call is now a true no-op; callers that need a re-record without
 *  a visibility change use `invalidateRenderBundles`. */
export function setSubtreeVisible(node: SceneNode, v: boolean): void {
    if (cascade(node, v)) {
        bumpVisibilityEpoch();
    }
}

function cascade(node: SceneNode, v: boolean): boolean {
    let changed = node.visible !== v;
    node.visible = v;
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
        if (cascade(kids[i]!, v)) {
            changed = true;
        }
    }
    return changed;
}
