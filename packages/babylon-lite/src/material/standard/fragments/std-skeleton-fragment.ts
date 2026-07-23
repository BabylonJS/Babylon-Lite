/** Standard wrapper around the shared material-agnostic skeleton fragment. */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createSkeletonFragment } from "../../../shader/fragments/skeleton-fragment.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_SKELETON, HAS_SKELETON_8 } from "../standard-flags.js";
import { MSH_HAS_SKELETON, MSH_HAS_SKELETON_8, MSH_HAS_THIN_INSTANCES } from "../../mesh-features.js";

export const stdSkeletonExt: StdExt = {
    _id: "std-skeleton",
    _phase: "mesh",
    _feature: HAS_SKELETON,
    _meshFeatures(meshFeatures) {
        if ((meshFeatures & MSH_HAS_SKELETON) === 0 || (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0) {
            return 0;
        }
        return HAS_SKELETON | ((meshFeatures & MSH_HAS_SKELETON_8) !== 0 ? HAS_SKELETON_8 : 0);
    },
    _frag(features: number): ShaderFragment {
        const fragment = createSkeletonFragment((features & HAS_SKELETON_8) !== 0);
        return {
            ...fragment,
            _id: "std-skeleton",
            // Standard base bindings precede extension bindings, unlike PBR's
            // vertex-binding phase. Relocate the same declaration, not the WGSL.
            _bindings: fragment._vertexBindings,
            _vertexBindings: undefined,
        };
    },
    _bind(_material: StandardMaterialProps, entries, binding, mesh) {
        const skeleton = mesh?.skeleton;
        if (!skeleton) {
            return binding;
        }
        entries.push({ binding: binding++, resource: skeleton.boneTexture.createView() });
        return binding;
    },
    _bindVertexBuffers(mesh, pass, slot) {
        const skeleton = mesh.skeleton;
        if (!skeleton) {
            return slot;
        }
        pass.setVertexBuffer(slot++, skeleton.jointsBuffer);
        pass.setVertexBuffer(slot++, skeleton.weightsBuffer);
        if (skeleton.joints1Buffer && skeleton.weights1Buffer) {
            pass.setVertexBuffer(slot++, skeleton.joints1Buffer);
            pass.setVertexBuffer(slot++, skeleton.weights1Buffer);
        }
        return slot;
    },
};
