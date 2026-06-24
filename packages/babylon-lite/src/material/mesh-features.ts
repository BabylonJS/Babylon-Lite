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
/** Mesh world transform has a positive determinant (mirrored vs the RH→LH root):
 *  its triangle winding is reversed, so back-face culling must flip (cull "front"). */
export const MSH_REVERSE_WINDING = 1 << 11;
/** Non-triangle-list primitive topology, encoded as a 3-bit index in bits 12-14
 *  (1=point-list, 2=line-list, 3=line-strip, 4=triangle-strip; 0=triangle-list).
 *  Set from the glTF primitive `mode`; the PBR pipeline maps it to the GPU topology. */
export const MSH_TOPOLOGY_SHIFT = 12;
export const MSH_TOPOLOGY_MASK = 7 << MSH_TOPOLOGY_SHIFT;
/** A line-strip / triangle-strip mesh uses a uint32 index buffer (vs uint16). WebGPU
 *  needs the pipeline's `stripIndexFormat` to match the index buffer for indexed strip
 *  draws. Set only for strip topologies, so non-strip meshes are unaffected. */
export const MSH_INDEX_U32 = 1 << 15;

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
    if ((mesh as { _reverseWinding?: boolean })._reverseWinding) {
        features |= MSH_REVERSE_WINDING;
    }
    const topo = (mesh as { _topology?: number })._topology;
    if (topo) {
        features |= topo << MSH_TOPOLOGY_SHIFT;
        // Strips (3=line-strip, 4=triangle-strip) need the pipeline stripIndexFormat to match the
        // index buffer; flag uint32 so the pipeline picks the right format. Lite always draws indexed.
        if (topo >= 3 && gpu.indexFormat === "uint32") {
            features |= MSH_INDEX_U32;
        }
    }
    if (receiveShadows) {
        features |= MSH_RECEIVE_SHADOWS;
    }
    return features;
}
