/** glTF animation feature.
 *  Triggered when the asset has any animations. Per-asset hook parses clips,
 *  binds them to the uploaded meshes, and returns AnimationGroups. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "_animations",
    async applyAsset(meshes, _root, ctx) {
        const [{ parseAnimationData }, { createAnimationGroups }] = await Promise.all([import("./gltf-animation.js"), import("../animation/animation-group.js")]);
        const animData = parseAnimationData(ctx._json, ctx._binChunk, meshes, ctx._parentMap, ctx._worldMatrixCache, ctx._nodeMap);
        if (!animData) {
            return {};
        }
        return { animationGroups: createAnimationGroups(animData) };
    },
};
export default feature;
