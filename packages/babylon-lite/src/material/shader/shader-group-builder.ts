import type { MeshGroupBuilder } from "../../render/renderable.js";

export const shaderGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    const { buildShaderMaterialRenderables } = await import("./shader-renderable.js");
    const result = buildShaderMaterialRenderables(scene, meshes);
    shaderGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};
