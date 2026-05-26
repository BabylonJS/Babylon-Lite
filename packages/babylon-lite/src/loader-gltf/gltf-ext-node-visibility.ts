/** glTF KHR_node_visibility extension.
 *
 *  Sets `node.visible = false` on SceneNodes whose glTF node has
 *  `extensions.KHR_node_visibility.visible === false`, and cascades
 *  through the subtree via `setSubtreeVisible` so that descendants
 *  inherit the invisibility per the extension spec. The render path
 *  and camera-AABB filter then skip them. Combined with
 *  KHR_animation_pointer, the visible flag can also be toggled at runtime.
 *
 *  Dynamically imported by load-gltf only when the asset declares the
 *  extension in `extensionsUsed`, so bundles pay zero bytes otherwise. */

import type { GltfFeature } from "./gltf-feature.js";
import type { SceneNode } from "../scene/scene-node.js";
import { setSubtreeVisible } from "../scene/visibility.js";

function applyVisibility(json: any, nodeMap: readonly (SceneNode | undefined)[]): void {
    const nodes = json.nodes ?? [];
    for (let i = 0; i < nodes.length; i++) {
        const vis = nodes[i]?.extensions?.KHR_node_visibility?.visible;
        const sn = nodeMap[i];
        if (vis === false && sn) {
            setSubtreeVisible(sn, false);
        }
    }
}

const ext: GltfFeature = {
    id: "KHR_node_visibility",
    async applyAsset(_meshes, _root, ctx) {
        if (ctx._nodeMap) {
            applyVisibility(ctx._json, ctx._nodeMap);
        }
        return {};
    },
};
export default ext;
