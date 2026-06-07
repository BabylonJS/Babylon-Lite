import type { MeshGroupBuilder } from "../../render/renderable.js";

export const shaderGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    // `buildShaderGroup` takes the synchronous, instancing-free fast path for
    // non-instanced ShaderMaterial scenes and only dynamic-imports the instancing
    // module when a mesh actually uses thin instances. Detection + helper handoff
    // live in `shader-renderable.ts` so this main-chunk seam stays tiny and no
    // instancing helpers get exported (which would de-mangle them).
    const { buildShaderGroup } = await import("./shader-renderable.js");
    const result = await buildShaderGroup(scene, meshes);
    shaderGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};
