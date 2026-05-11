import type { Mesh, MeshInternal } from "../mesh/mesh.js";

export const MESH_HAS_TANGENTS = 1 << 0;
export const MESH_HAS_SKELETON = 1 << 1;
export const MESH_HAS_SKELETON_8 = 1 << 2;
export const MESH_HAS_MORPH_TARGETS = 1 << 3;
export const MESH_HAS_THIN_INSTANCES = 1 << 4;
export const MESH_HAS_INSTANCE_COLOR = 1 << 5;
export const MESH_HAS_VERTEX_COLOR = 1 << 6;
export const MESH_HAS_UV2 = 1 << 7;
export const MESH_RECEIVE_SHADOWS = 1 << 8;

/** @internal Compute mesh/pass feature bits shared by material renderers. */
export function _computeMeshFeatures(mesh: Mesh, receiveShadows = false): number {
    const gpu = (mesh as MeshInternal)._gpu;
    let features = 0;
    if (gpu.tangentBuffer) {
        features |= MESH_HAS_TANGENTS;
    }
    if (mesh.skeleton) {
        features |= MESH_HAS_SKELETON;
        if (mesh.skeleton.joints1Buffer) {
            features |= MESH_HAS_SKELETON_8;
        }
    }
    if (mesh.morphTargets) {
        features |= MESH_HAS_MORPH_TARGETS;
    }
    if (mesh.thinInstances) {
        features |= MESH_HAS_THIN_INSTANCES;
        if (mesh.thinInstances.colors) {
            features |= MESH_HAS_INSTANCE_COLOR;
        }
    }
    if (gpu.colorBuffer) {
        features |= MESH_HAS_VERTEX_COLOR;
    }
    if (gpu.uv2Buffer) {
        features |= MESH_HAS_UV2;
    }
    if (receiveShadows) {
        features |= MESH_RECEIVE_SHADOWS;
    }
    return features;
}
