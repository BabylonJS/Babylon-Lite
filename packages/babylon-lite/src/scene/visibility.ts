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
 *  only has to check a single boolean per mesh. */
export function setSubtreeVisible(node: SceneNode, v: boolean): void {
    cascade(node, v);
    bumpVisibilityEpoch();
}

function cascade(node: SceneNode, v: boolean): void {
    node.visible = v;
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
        cascade(kids[i]!, v);
    }
}
