/**
 * PBR Morph Target Extension
 *
 * Wires the shared morph fragment (shader/fragments/morph-fragment-core.ts)
 * into the PBR material as a vertex-phase extension. The morph WGSL is
 * composed at pipeline creation time — no global registration needed.
 */

import { createMorphFragment } from "../../../shader/fragments/morph-fragment-core.js";
import type { PbrExt } from "../pbr-flags.js";
import { MSH_HAS_MORPH_TARGETS } from "../../mesh-features.js";

export { createMorphFragment };

export const pbrExt: PbrExt = {
    id: "morph",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS)) {
            return null;
        }
        return createMorphFragment();
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh;
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS) || !mesh?.morphTargets) {
            return b;
        }
        entries.push({ binding: b++, resource: { buffer: mesh.morphTargets.deltasBuffer } });
        // Weights buffer is pushed separately by the pipeline (needs engine-side buffer handle).
        // Caller supplies weightsBuffer on mesh.morphTargets.
        if (mesh.morphTargets.weightsBuffer) {
            entries.push({ binding: b++, resource: { buffer: mesh.morphTargets.weightsBuffer } });
        }
        return b;
    },
};
