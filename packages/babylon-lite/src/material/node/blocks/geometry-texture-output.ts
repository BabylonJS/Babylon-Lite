/** GeometryTextureOutputBlock emitter — the geometry-pass fragment terminal.
 *
 *  Lite analogue of Babylon.js' `PrePassOutputBlock`. Declares one optional
 *  input per {@link GeometryTextureType} (11 total). For every CONNECTED input
 *  it resolves + casts the upstream value and stashes the WGSL expression onto
 *  `state._geometryInputs`, keyed by the geometry texture type. It never writes
 *  `_NME_FRAG_OUTPUT_` — the node pipeline's geometry path (see
 *  node-geometry-view.ts / node-pipeline.ts `_mrtOutput`) turns the stashed
 *  expressions into the multi-attachment `FragmentOutput` writes, filling any
 *  unconnected attachment with the engine default.
 *
 *  This block is only ever emitted when the graph is re-walked from this
 *  terminal during a geometry-renderer pass; the normal colour pass walks the
 *  `FragmentOutputBlock` instead and never touches this code.
 */

import { GeometryTextureType } from "../../../frame-graph/geometry-types.js";
import type { BlockEmitter, NodeBuildState, NodeExpr, NodeValueType } from "../node-types.js";

/** input name → (geometry texture type, cast target) */
const INPUTS: ReadonlyArray<readonly [string, GeometryTextureType, NodeValueType]> = [
    ["worldPosition", GeometryTextureType.WORLD_POSITION, "vec3f"],
    ["localPosition", GeometryTextureType.LOCAL_POSITION, "vec3f"],
    ["worldNormal", GeometryTextureType.WORLD_NORMAL, "vec3f"],
    ["viewNormal", GeometryTextureType.VIEW_NORMAL, "vec3f"],
    ["reflectivity", GeometryTextureType.REFLECTIVITY, "vec4f"],
    ["albedo", GeometryTextureType.ALBEDO, "vec3f"],
    ["irradiance", GeometryTextureType.IRRADIANCE, "vec3f"],
    ["viewDepth", GeometryTextureType.VIEW_DEPTH, "f32"],
    ["normalizedViewDepth", GeometryTextureType.NORMALIZED_VIEW_DEPTH, "f32"],
    ["screenspaceDepth", GeometryTextureType.SCREENSPACE_DEPTH, "f32"],
    ["linearVelocity", GeometryTextureType.LINEAR_VELOCITY, "vec3f"],
];

function geometryInputs(state: NodeBuildState): Map<GeometryTextureType, NodeExpr> {
    if (!state._geometryInputs) {
        state._geometryInputs = new Map<GeometryTextureType, NodeExpr>();
    }
    return state._geometryInputs;
}

export const emitter: BlockEmitter = {
    className: "GeometryTextureOutputBlock",
    stage: "fragment",
    emit(block, _outputName, stage, state, ctx) {
        const out = geometryInputs(state);
        for (const [name, type, cast] of INPUTS) {
            const conn = block.inputs.get(name);
            if (conn && conn.source) {
                const value = ctx.cast(ctx.resolve(block, name, stage, state), cast);
                // Stash via an SSA temp so the geometry write site references a
                // single stable identifier rather than re-evaluating the chain.
                const t = ctx.temp(state, "geom");
                state.fragment.body.push(`let ${t} = ${value.expr};`);
                out.set(type, { expr: t, type: value.type });
            }
        }
        // Terminal block — the returned value is never consumed.
        return { expr: "vec4<f32>(0.0, 0.0, 0.0, 1.0)", type: "vec4f" };
    },
};
