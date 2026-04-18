/** Morph target feature. */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "_morph",
    async applyMesh(meshData, mesh, ctx) {
        if (!meshData.morphTargets || meshData.morphTargets.length === 0) {
            return;
        }
        const { createMorphTargets } = await import("../morph/create-morph-targets.js");
        mesh.morphTargets = createMorphTargets(ctx.engine, meshData.morphTargets, meshData.vertexCount, meshData.morphWeights);
    },
};
export default feature;
