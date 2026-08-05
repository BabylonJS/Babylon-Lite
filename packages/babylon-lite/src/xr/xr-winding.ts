import { _installPbrReverseWindingHook } from "../material/pbr/pbr-pipeline.js";
import { _installStdReverseWindingHook } from "../material/standard/standard-pipeline.js";
import { _installReverseWindingKeyHook } from "../engine/render-target.js";
import { _installReverseWindingSig } from "../frame-graph/render-task.js";

/** Flip a pipeline's `frontFace` (ccw↔cw), composing with any per-mesh mirrored winding already
 *  chosen by the primitive resolver. XR eye targets render the scene's right-handed view/projection
 *  matrices verbatim through Lite's left-handed rasterizer; that handedness flip inverts apparent
 *  triangle winding, so forward pipelines targeting an eye RT flip `frontFace` (not the cull face,
 *  which would leave `@builtin(front_facing)` — and thus double-sided shading normals — evaluated
 *  against the un-flipped winding) to keep front faces visible and shading correct. */
function flipFrontFace(primitive: GPUPrimitiveState): GPUPrimitiveState {
    return { ...primitive, frontFace: primitive.frontFace === "cw" ? "ccw" : "cw" };
}

let _installed = false;

/** @internal Install the reverse-winding hooks into the forward pipelines and the render-target
 *  key builder. Called from `enterXr`; idempotent. Because the pipeline/key modules only import
 *  the flip through these setters — never the reverse — non-XR bundles that never reach `enterXr`
 *  tree-shake this module entirely and keep the pipeline hot paths byte-identical. */
export function enableXrReverseWinding(): void {
    if (_installed) {
        return;
    }
    _installed = true;
    _installPbrReverseWindingHook(flipFrontFace);
    _installStdReverseWindingHook(flipFrontFace);
    // The render task copies `_reverseWinding` from the eye target's descriptor onto its pipeline
    // signature; the key hook then discriminates those pipelines so they don't collide with the
    // upright canvas pipelines.
    _installReverseWindingSig((desc) => (desc._reverseWinding ? { _reverseWinding: true } : {}));
    _installReverseWindingKeyHook((desc) => (desc._reverseWinding ? "|rw" : ""));
}
