import type { MeshGroupBuilder } from "../../render/renderable.js";

/** Lazily-created singleton ShaderMaterial {@link MeshGroupBuilder}. Lazy-init keeps
 *  the module free of top-level side effects so a scene that uses no ShaderMaterial
 *  tree-shakes it away.
 *
 *  The `_materialFamily` ("shader") marks this family so the shadow caster pass can
 *  render a custom ShaderMaterial into the (depth-only) shadow map via a no-color
 *  material view — the shader pipeline already drops its fragment stage when the
 *  render target has no colour attachment, and each view gets its own system UBO
 *  (written with the shadow camera), so a ShaderMaterial mesh can cast like the
 *  standard/pbr/node families. */
let _shaderGroupBuilder: MeshGroupBuilder | null = null;
export function getShaderGroupBuilder(): MeshGroupBuilder {
    if (_shaderGroupBuilder) {
        return _shaderGroupBuilder;
    }
    const builder: MeshGroupBuilder = async (scene, meshes) => {
        // `buildShaderGroup` takes the synchronous, instancing-free fast path for
        // non-instanced ShaderMaterial scenes and only dynamic-imports the instancing
        // module when a mesh actually uses thin instances. Detection + helper handoff
        // live in `shader-renderable.ts` so this main-chunk seam stays tiny and no
        // instancing helpers get exported (which would de-mangle them).
        const { buildShaderGroup } = await import("./shader-renderable.js");
        const result = await buildShaderGroup(scene, meshes);
        builder._rebuildSingle = result.rebuildSingle;
        return result;
    };
    builder._materialFamily = "shader";
    return (_shaderGroupBuilder = builder);
}
