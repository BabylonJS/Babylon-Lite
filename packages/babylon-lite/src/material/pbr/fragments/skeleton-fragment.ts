/**
 * Skeleton Fragment (PBR ext wrapper)
 *
 * Re-exports the shared, material-agnostic skeleton fragment and wraps it in a
 * PBR extension (`PbrExt`) so the PBR composer can detect/bind skinning.
 * The shared `createSkeletonFragment` lives in `shader/fragments/skeleton-fragment.ts`
 * and is reused by the Standard material side without pulling in this wrapper.
 * PBR keeps the default `"vertex"` binding style (bone texture placed before base
 * bindings) — behaviour identical to before the move.
 */

import { createSkeletonFragment } from "../../../shader/fragments/skeleton-fragment.js";

export { createSkeletonFragment };

import type { PbrExt } from "../pbr-flags.js";
import { MSH_HAS_SKELETON, MSH_HAS_SKELETON_8 } from "../../mesh-features.js";

export const pbrExt: PbrExt = {
    id: "skeleton",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_HAS_SKELETON)) {
            return null;
        }
        return createSkeletonFragment((ctx._meshFeatures & MSH_HAS_SKELETON_8) !== 0);
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh as { skeleton?: { boneTexture: GPUTexture } } | undefined;
        if (!(ctx._meshFeatures & MSH_HAS_SKELETON) || !mesh?.skeleton) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.skeleton.boneTexture.createView() });
        return b;
    },
};
