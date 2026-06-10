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
    if (receiveShadows) {
        features |= MSH_RECEIVE_SHADOWS;
    }
    return features;
}
