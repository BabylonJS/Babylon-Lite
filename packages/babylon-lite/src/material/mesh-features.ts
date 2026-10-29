import type { Mesh } from "../mesh/mesh.js";
import { _rightHanded } from "#coordinate-system";

export const MSH_HAS_TANGENTS = 1 << 0;
export const MSH_HAS_SKELETON = 1 << 1;
export const MSH_HAS_SKELETON_8 = 1 << 2;
export const MSH_HAS_MORPH_TARGETS = 1 << 3;
export const MSH_HAS_THIN_INSTANCES = 1 << 4;
export const MSH_HAS_INSTANCE_COLOR = 1 << 5;
export const MSH_HAS_VERTEX_COLOR = 1 << 6;
export const MSH_HAS_UV2 = 1 << 7;
export const MSH_RECEIVE_SHADOWS = 1 << 8;
export const MSH_VAT = 1 << 9;
/** Mesh has no NORMAL attribute → must be flat-shaded (glTF spec). */
export const MSH_FLAT_NORMAL = 1 << 10;
// Bits 11-15 (negative-winding + 3-bit topology index + uint32-strip flag) are owned by the lazy
// glTF primitive feature, which pre-encodes them on the affected meshes as `_primitiveFeatures`.
// The PBR renderables fold those in themselves — they exist only to key the composed shader variant,
// which the Standard path has no equivalent of — so nothing here has to read them, except the
// winding bit in a right-handed build (see the end of `_computeMeshFeatures`).

/** Extra mesh-feature encoder installed only by runtime opt-ins such as mirrored procedural meshes. */
let _meshFeatureExtra: ((mesh: Mesh) => number) | null = null;
/** @internal Install an extra mesh-feature encoder. */
export function _installMeshFeatureExtra(encode: (mesh: Mesh) => number): void {
    _meshFeatureExtra = encode;
}

/** @internal The tangent bit alone — side-effect free, unlike `_computeMeshFeatures` (see `_meshFeatureExtra`). */
export function _meshTangentFeature(mesh: Mesh): number {
    return mesh._gpu.tangentBuffer ? MSH_HAS_TANGENTS : 0;
}

/** @internal Compute mesh/pass feature bits shared by material renderers. */
export function _computeMeshFeatures(mesh: Mesh, receiveShadows = false): number {
    const gpu = mesh._gpu;
    let features = _meshTangentFeature(mesh);
    if (mesh.vat) {
        // Baked vertex animation: the VAT vertex path replaces live skinning (still uses the 8-bone
        // joints1 attribute flag when present), so don't also set MSH_HAS_SKELETON.
        features |= MSH_VAT;
        if (mesh.vat.joints1Buffer) {
            features |= MSH_HAS_SKELETON_8;
        }
    } else if (mesh.skeleton) {
        features |= MSH_HAS_SKELETON;
        if (mesh.skeleton.joints1Buffer) {
            features |= MSH_HAS_SKELETON_8;
        }
    }
    if (mesh.morphTargets) {
        features |= MSH_HAS_MORPH_TARGETS;
    }
    if (mesh.thinInstances) {
        features |= MSH_HAS_THIN_INSTANCES;
        if (mesh.thinInstances.colors) {
            features |= MSH_HAS_INSTANCE_COLOR;
        }
    }
    if (gpu.colorBuffer) {
        features |= MSH_HAS_VERTEX_COLOR;
    }
    if (gpu.uv2Buffer) {
        features |= MSH_HAS_UV2;
    }
    if ((mesh as { _flatNormal?: boolean })._flatNormal) {
        features |= MSH_FLAT_NORMAL;
    }
    if (receiveShadows) {
        features |= MSH_RECEIVE_SHADOWS;
    }
    if (_meshFeatureExtra) {
        features |= _meshFeatureExtra(mesh);
    }
    if (_rightHanded) {
        // Right-handed glTF geometry keeps glTF's own winding (no mirroring root), unlike procedural
        // meshes: carry the loader's winding bit so the Standard pipelines key and wind it apart.
        // Read after the opt-in encoder above, which takes ownership of (and clears) that bit.
        features |= ((mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0) & (1 << 11);
    }
    return features;
}
