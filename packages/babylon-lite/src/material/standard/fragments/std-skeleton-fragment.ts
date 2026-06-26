/** Standard Skeleton Extension — vertex-stage skeletal (skinning) deformation wired as a
 *  plain StdExt. Reuses the shared, material-agnostic skeleton fragment (the same
 *  WGSL/attributes/helper/VW used by PBR) and relocates its single bone-texture binding
 *  from `_vertexBindings` to `_bindings` (afterBase) so the bone texture lands AFTER the
 *  base bindings, where the shared StdExt bind loop already runs. Doing the relocation here
 *  (rather than parameterizing the shared factory) keeps the PBR skeleton chunk byte-identical
 *  to before the fragment was shared. Gated on the mesh-driven HAS_SKELETON feature bit
 *  (8-bone via HAS_SKELETON_8). The joints/weights vertex buffers are bound generically
 *  through `_bindVertexBuffers`, mirroring the PBR draw's skinning vertex-buffer order. */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createSkeletonFragment } from "../../../shader/fragments/skeleton-fragment.js";
import type { Mesh } from "../../../mesh/mesh.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_SKELETON, HAS_SKELETON_8 } from "../standard-flags.js";
import { _installStdExtFeature } from "../std-feature-hooks.js";

/** Registry extension gated on `HAS_SKELETON`. The bone texture is a vertex-only mesh-driven
 *  resource, so `_bind` pulls it off the mesh (not the material) and pushes it in the same
 *  order the composer declares it (afterBase). `_bindVertexBuffers` binds the joints/weights
 *  (+joints1/weights1 for 8-bone) draw-time vertex buffers in the composer's attribute order.
 *  No `_textures` — the bone texture is owned by the mesh's skeleton system, not the GPU pool. */
export const stdSkeletonExt: StdExt = {
    _id: "skeleton",
    _phase: "mesh",
    _feature: HAS_SKELETON,
    _frag: (features: number): ShaderFragment => {
        // Reuse the shared fragment (PBR's "vertex" placement) and relocate the single bone
        // binding to `_bindings` so the Standard composer's trailing ext-bind loop binds it
        // after the base bindings — matching `_bind` below.
        const frag = createSkeletonFragment((features & HAS_SKELETON_8) !== 0);
        return { ...frag, _bindings: frag._vertexBindings, _vertexBindings: undefined };
    },
    _bind(_mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number, mesh?: Mesh): number {
        entries.push({ binding: b++, resource: mesh!.skeleton!.boneTexture.createView() });
        return b;
    },
    _bindVertexBuffers(mesh: Mesh, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number): number {
        const s = mesh.skeleton;
        if (!s) {
            return slot;
        }
        pass.setVertexBuffer(slot++, s.jointsBuffer);
        pass.setVertexBuffer(slot++, s.weightsBuffer);
        if (s.joints1Buffer && s.weights1Buffer) {
            pass.setVertexBuffer(slot++, s.joints1Buffer);
            pass.setVertexBuffer(slot++, s.weights1Buffer);
        }
        return slot;
    },
};

// Loading this chunk wires the skeleton feature bit into the bundle (folds the renderable's
// feature-OR branch in scenes that never enable skinning). See standard-renderable._stdExtBits.
_installStdExtFeature(HAS_SKELETON);
