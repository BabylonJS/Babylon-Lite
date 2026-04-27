/** DiscardBlock — fragment-stage discard.
 *
 *  Inputs: `value` (scalar), `cutoff` (scalar).
 *  Semantics (BJS): if `value < cutoff` then `discard`.
 *
 *  The block has no output expression — it pushes a guarded `discard;` statement
 *  into the fragment body during traversal. Because the pipeline walks from
 *  FragmentOutputBlock back through its inputs, DiscardBlock only executes when
 *  it is reachable from the final output via some consumer. In practice BJS
 *  attaches it to FragmentOutputBlock via a dedicated connection or wires it
 *  upstream of the colour flow; we support the latter shape here — any block
 *  whose output reaches FragmentOutputBlock will cause the discard to be
 *  emitted. To guarantee emission even when not directly in the colour path,
 *  we wire DiscardBlock into the emit loop via the has-side-effects list
 *  maintained by node-emitter.ts.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "DiscardBlock",
    stage: "fragment",
    sideEffect: true,
    emit(block, _outputName, stage, state, ctx) {
        const memoKey = `_discard_${block.id}_emit`;
        if (!state.fragment.memo.has(memoKey)) {
            const valueIn = block.inputs.get("value");
            const cutoffIn = block.inputs.get("cutoff");
            const value = valueIn?.source ? ctx.cast(ctx.resolve(block, "value", stage, state), "f32") : { expr: "0.0", type: "f32" as const };
            const cutoff = cutoffIn?.source ? ctx.cast(ctx.resolve(block, "cutoff", stage, state), "f32") : { expr: "0.0", type: "f32" as const };
            state.fragment.body.push(`if (${value.expr} < ${cutoff.expr}) { discard; }`);
            state.fragment.memo.set(memoKey, { expr: "0.0", type: "f32" });
        }
        return { expr: "0.0", type: "f32" };
    },
};
