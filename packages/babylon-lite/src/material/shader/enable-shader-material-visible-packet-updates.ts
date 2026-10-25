import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderMaterial } from "./shader-material.js";

/** Defer hidden packets' system-uniform and resource updates for one ShaderMaterial.
 * Shared custom uniforms, transparent sorting and initial allocation remain unchanged.
 * Use `setMeshVisible` to invalidate cached bundles when hiding or restoring meshes.
 * Pending packet changes are refreshed by the normal per-pass update before the restored draw.
 * Material views created from `material` inherit this policy.
 * @param material - Material whose packets should update only while visible.
 */
export function enableShaderMaterialVisiblePacketUpdates(material: ShaderMaterial): void {
    material._deferPacketUpdate = isHidden;
}

function isHidden(mesh: Mesh): boolean {
    return mesh.visible === false;
}
