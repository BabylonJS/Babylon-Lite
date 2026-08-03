import type { Mesh } from "../mesh/mesh.js";

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
// glTF primitive feature. It pre-encodes those bits on affected meshes, so the loader's resolver
// machinery stays out of the shared mesh-feature path.
/** Reverse-winding bit. Named here — unlike the topology bits — because the live winding rule
 *  below has to be able to CLEAR it, not just contribute it. */
const MSH_REVERSE_WINDING = 1 << 11;

/** Extra mesh-feature encoder installed only by runtime opt-ins such as mirrored procedural meshes. */
let _meshFeatureExtra: ((mesh: Mesh) => number) | null = null;
/** @internal Install an extra mesh-feature encoder. */
export function _installMeshFeatureExtra(encode: (mesh: Mesh) => number): void {
    _meshFeatureExtra = encode;
}

/** @internal Compute mesh/pass feature bits shared by material renderers. */
export function _computeMeshFeatures(mesh: Mesh, receiveShadows = false): number {
    const gpu = mesh._gpu;
    let features = 0;
    if (gpu.tangentBuffer) {
        features |= MSH_HAS_TANGENTS;
    }
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
    const primitiveFeatures = (mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0;
    if (_meshFeatureExtra) {
        // The live rule OWNS the winding bit; the loader's is only a snapshot of the determinant at
        // load time. `enableMirroredMeshes` derives winding from the CURRENT world matrix, so a glTF
        // mesh that was mirrored at load and is later un-mirrored (re-parented, scale sign flipped)
        // must lose the bit. OR-ing the two could only ever set it, leaving the rebuilt pipeline
        // stuck on frontFace "cw" — the same inside-out/black rendering this branch exists to fix,
        // just in the opposite direction. The loader's topology bits are untouched.
        features |= (primitiveFeatures & ~MSH_REVERSE_WINDING) | _meshFeatureExtra(mesh);
    } else {
        features |= primitiveFeatures;
    }
    return features;
}
