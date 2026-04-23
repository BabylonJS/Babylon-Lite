/** MorphTargetsBlock — applies per-target position/normal deltas sampled
 *  from the morph-atlas texture.
 *
 *  Inputs:  position (vec3), normal (vec3), tangent (vec4), uv (vec2).
 *  Outputs: positionOutput, normalOutput, tangentOutput, uvOutput.
 *
 *  Only position and normal are currently wired to a real morph accumulation;
 *  tangent/uv/uv2 are pass-through (Lite's morph atlas carries only pos/norm
 *  deltas — see morph/create-morph-targets.ts). If a graph consumes
 *  tangentOutput/uvOutput we simply return the base input.
 *
 *  The block sets `state.usesMorphTargets`; node-pipeline.ts adds the
 *  `morphTargets` texture + `morph` UBO bindings, emits the struct +
 *  helper functions at module scope, and wires `@builtin(vertex_index)`
 *  through as `vertexIndex` so the helpers can locate this vertex's row.
 */

import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";

const PASSTHROUGH_KINDS = new Set(["tangent", "uv", "uv2"]);

export const emitter: BlockEmitter = {
    className: "MorphTargetsBlock",
    stage: "vertex",
    emit(block, outputName, stage, state, ctx) {
        state.usesMorphTargets = true;
        const kind = outputName.replace(/Output$/, ""); // position | normal | tangent | uv
        const input = block.inputs.get(kind);
        if (!input?.source) {
            return fallback(kind);
        }
        const v = ctx.resolve(block, kind, stage, state);
        if (kind === "position") {
            const base = ctx.cast(v, "vec3f").expr;
            return { expr: `nme_morphPosition(${base}, vertexIndex)`, type: "vec3f" };
        }
        if (kind === "normal") {
            const base = ctx.cast(v, "vec3f").expr;
            return { expr: `nme_morphNormal(${base}, vertexIndex)`, type: "vec3f" };
        }
        // Tangent/uv/uv2 — no delta bands stored; pass through.
        if (PASSTHROUGH_KINDS.has(kind)) {
            return v;
        }
        return v;
    },
};

function fallback(kind: string): NodeExpr {
    const type: NodeValueType = kind === "uv" || kind === "uv2" ? "vec2f" : kind === "tangent" ? "vec4f" : "vec3f";
    const zero = type === "vec2f" ? "vec2<f32>(0.0)" : type === "vec4f" ? "vec4<f32>(0.0)" : "vec3<f32>(0.0)";
    return { expr: zero, type };
}
