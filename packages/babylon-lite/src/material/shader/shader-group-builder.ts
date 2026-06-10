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

// Marks this family so the shadow caster pass can render a custom ShaderMaterial into the (depth-only)
// shadow map via a no-color material view — the shader pipeline already drops its fragment stage when the
// render target has no colour attachment, and each view gets its own system UBO (written with the shadow
// camera), so a ShaderMaterial mesh can cast like the standard/pbr/node families.
shaderGroupBuilder._materialFamily = "shader";
