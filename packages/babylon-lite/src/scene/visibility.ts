/** Subtree visibility cascade helper. Only imported by modules that toggle
 *  visibility (KHR_node_visibility loader, KHR_animation_pointer writer) —
 *  bundle cost is paid only by scenes that actually use those features.
 *
 *  This helper is the sole place that bumps the module-scoped visibility
 *  epoch (see `visibility-epoch.ts`), so the engine's bundle invalidation
 *  is O(1) and the hot SceneNode write path stays a plain field assignment. */

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
