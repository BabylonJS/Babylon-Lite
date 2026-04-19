/** glTF animation feature.
 *  Triggered when the asset has any animations. Per-asset hook parses clips,
 *  binds them to the uploaded meshes, and returns AnimationGroups. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "_animations",
    async applyAsset(meshes, _root, ctx) {
        const [{ parseAnimationData }, { createAnimationGroups }] = await Promise.all([import("./gltf-animation.js"), import("../animation/animation-group.js")]);
        const animData = parseAnimationData(ctx.json, ctx.binChunk, meshes, ctx.parentMap, ctx.worldMatrixCache);
        if (!animData || animData.clips.length === 0 || (animData.skeletons.length === 0 && animData.morphBindings.length === 0)) {
            return {};
        }
        return { animationGroups: createAnimationGroups(animData) };
    },
};
export default feature;
