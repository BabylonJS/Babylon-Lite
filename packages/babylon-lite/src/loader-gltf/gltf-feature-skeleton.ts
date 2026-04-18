/** Skeletal animation feature. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "_skeleton",
    async applyMesh(meshData, mesh, ctx) {
        if (!meshData.joints || !meshData.weights || !meshData.skin) {
            return;
        }
        const [{ computeBoneTextureData }, { createSkeleton }] = await Promise.all([import("./gltf-animation.js"), import("../skeleton/create-skeleton.js")]);
        const boneCount = meshData.skin.jointNodes.length;
        const boneData = computeBoneTextureData(meshData.skin);
        mesh.skeleton = createSkeleton(ctx.engine, meshData.joints, meshData.weights, boneCount, boneData, meshData.joints1, meshData.weights1);
    },
};
export default feature;
