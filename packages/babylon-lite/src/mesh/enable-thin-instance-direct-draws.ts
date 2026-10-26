import { bumpVisibilityEpoch } from "../engine/engine.js";
import type { Mesh } from "./mesh.js";

/** Keep thin-instance count changes on direct indexed draws, re-recording cached bundles when needed.
 * Call after creating thin instances and before registerScene(). Incompatible with GPU culling,
 * thin-instance LOD pairing and stable indirect draw-count warm-up. Shared thin-instance data shares
 * this policy. Defaults are unchanged; there is no browser-specific behavior or runtime disable API. */
export function enableThinInstanceDirectDraws(mesh: Mesh): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        throw new Error("enableThinInstanceDirectDraws requires mesh.thinInstances");
    }
    if (ti._gpuCullingEnabled || ti._lodSource || ti._lodPartner) {
        throw new Error("Thin-instance direct draws do not support GPU culling or LOD pairing");
    }
    if (ti._drawArgsBuffer || ti._drawArgsInstanceCount === -1) {
        throw new Error("enableThinInstanceDirectDraws must precede stable indirect draw arguments or dynamic draw-count warm-up");
    }
    ti._drawCountPolicy ??= {
        _sync(count): void {
            if (ti._drawArgsInstanceCount !== undefined && ti._drawArgsInstanceCount !== count) {
                bumpVisibilityEpoch();
            }
            ti._drawArgsInstanceCount = count;
        },
        _requireIndirect(enabled): void {
            if (enabled) {
                throw new Error("Thin-instance direct draws do not support GPU culling, LOD pairing or stable indirect draw-count warm-up");
            }
        },
    };
}
