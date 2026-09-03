/** Explicit shadow-caster material override.
 *
 *  A material normally casts its own shadow through a depth-only "no colour" view of itself. That view
 *  shares the source material's bind group, so a material that RECEIVES shadows through resources which
 *  alias the shadow map (a custom `ShaderMaterial` binding the CSM depth array, for example) cannot cast
 *  through itself: the caster pass would sample the very texture it renders into.
 *
 *  Pointing the material at a sampler-free caster material fixes that without duplicating geometry — the
 *  caster keeps the same vertex stage (and may share the same storage buffers), so GPU-deformed surfaces
 *  cast exactly the silhouette they draw. */

import type { Material } from "./material.js";

/**
 * Sets the material a mesh's shadow is cast through, instead of a depth-only view of `material` itself.
 *
 * Honoured by the PCF and CSM caster paths (including the CSM static cache): they build the caster's
 * no-colour view from `casterMaterial` and re-evaluate the caster set when either material is rebuilt.
 * The ESM path renders casters through its own per-family ESM depth views and ignores the override.
 * The override material does not need to be assigned to any mesh or added to a scene.
 *
 * @param material - The material assigned to the mesh (the one that renders in the main pass).
 * @param casterMaterial - Material to cast this mesh's shadow through, or `null` to cast through `material`.
 */
export function setShadowCasterMaterial(material: Material, casterMaterial: Material | null): void {
    // Walk the proposed caster's own chain (the same links `getNoColorView` recurses through) and reject
    // any chain that loops back to `material`, not just a direct self-reference. Every existing chain is
    // already cycle-free (this check runs before every assignment), so the walk always terminates.
    let node: Material | undefined = casterMaterial ?? undefined;
    while (node) {
        if (node === material) {
            throw new Error("setShadowCasterMaterial: the caster chain must not cycle back to the source material");
        }
        node = node._shadowCasterMaterial;
    }
    material._shadowCasterMaterial = casterMaterial ?? undefined;
}
