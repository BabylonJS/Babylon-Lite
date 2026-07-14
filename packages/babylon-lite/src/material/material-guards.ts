import type { Material } from "./material.js";
import type { PbrMaterialProps } from "./pbr/pbr-material.js";
import type { StandardMaterialProps } from "./standard/standard-material.js";
import type { ShaderMaterial } from "./shader/shader-material.js";
import type { NodeMaterial } from "./node/node-material.js";
import { getMaterialFamily } from "./material-family.js";

// These type guards live in their own module (rather than inside the heavy material
// modules they narrow to) so they stay fully tree-shakable. The frame-graph geometry
// renderer dynamic-imports the whole `pbr-material`/`standard-material` namespaces, and
// Rollup cannot per-export tree-shake a dynamically imported module — so a guard placed
// there would be retained (dragging in `getMaterialFamily`) even for scenes that never
// call it. Keeping the guards here, with type-only imports of the concrete material
// types, means unused guards cost zero bytes. See getMaterialFamily for the family model.

/** TypeScript type guard: narrows a {@link Material} to {@link PbrMaterialProps} when it
 *  belongs to the PBR family (see {@link getMaterialFamily}). A {@link MaterialView} over a
 *  PBR source also passes, since it inherits every PBR property through its prototype chain. */
export function isPbrMaterial(material: Material): material is PbrMaterialProps {
    return getMaterialFamily(material) === "pbr";
}

/** TypeScript type guard: narrows a {@link Material} to {@link StandardMaterialProps} when it
 *  belongs to the standard family (see {@link getMaterialFamily}). A {@link MaterialView} over a
 *  standard source also passes, since it inherits every standard property through its prototype
 *  chain. */
export function isStandardMaterial(material: Material): material is StandardMaterialProps {
    return getMaterialFamily(material) === "standard";
}

/** TypeScript type guard: narrows a {@link Material} to {@link ShaderMaterial} when it belongs to
 *  the shader family (see {@link getMaterialFamily}). This also covers materials built on top of
 *  {@link createShaderMaterial}, such as the grid material. A {@link MaterialView} over a shader
 *  source also passes, since it inherits every shader property through its prototype chain. */
export function isShaderMaterial(material: Material): material is ShaderMaterial {
    return getMaterialFamily(material) === "shader";
}

/** TypeScript type guard: narrows a {@link Material} to {@link NodeMaterial} when it belongs to
 *  the node family (see {@link getMaterialFamily}). A {@link MaterialView} over a node source also
 *  passes, since it inherits every node property through its prototype chain. */
export function isNodeMaterial(material: Material): material is NodeMaterial {
    return getMaterialFamily(material) === "node";
}
