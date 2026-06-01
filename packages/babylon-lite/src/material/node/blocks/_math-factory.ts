/** Shared factories for NME math blocks.
 *
 *  Every block module uses these helpers to stay small — the registry still
 *  maps each BJS class name to its own dynamic import, so Rollup can emit one
 *  chunk per block. The factory code itself lands in a shared vendor chunk
 *  that is only pulled when at least one math block is used.
 */

import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeValueType } from "../node-types.js";

type Rank = 1 | 2 | 3 | 4;
const RANK: Record<NodeValueType, Rank | 0> = {
    f32: 1,
    vec2f: 2,
    vec3f: 3,
    vec4f: 4,
    mat4f: 0,
    texture2d: 0,
    textureCube: 0,
};
const RANK_TYPE: Record<Rank, NodeValueType> = { 1: "f32", 2: "vec2f", 3: "vec3f", 4: "vec4f" };

/** Pick the wider of two numeric NME types (`f32 < vec2 < vec3 < vec4`). */
export function widerType(a: NodeValueType, b: NodeValueType): NodeValueType {
    const ra = RANK[a] || 0;
    const rb = RANK[b] || 0;
    const r = Math.max(ra, rb) as Rank;
    if (!r) {
        throw new Error(`NodeMaterial: cannot pick common numeric type from ${a} and ${b}`);
    }
    return RANK_TYPE[r];
}

/** Binary op whose output type = widerType(left, right). */
export function binaryEmitter(className: string, op: (l: string, r: string) => string, leftName = "left", rightName = "right"): BlockEmitter {
    return {
        className,
        emit(block, _outputName, stage, state, ctx) {
            const l = ctx.resolve(block, leftName, stage, state);
            const r = ctx.resolve(block, rightName, stage, state);
            const t = widerType(l.type, r.type);
            const lc = ctx.cast(l, t).expr;
            const rc = ctx.cast(r, t).expr;
            return { expr: `(${op(lc, rc)})`, type: t };
        },
    };
}

/** Unary op — output type matches input. Optional `returnType` override. */
export function unaryEmitter(className: string, op: (v: string) => string, returnType?: NodeValueType, inputName = "input"): BlockEmitter {
    return {
        className,
        emit(block, _outputName, stage, state, ctx) {
            const v = ctx.resolve(block, inputName, stage, state);
            return { expr: `(${op(v.expr)})`, type: returnType ?? v.type };
        },
    };
}

/** Resolve an input, or fall back to a serialized scalar literal on the block. */
export function resolveOrScalar(block: NodeBlock, inputName: string, fallbackKey: string, stage: Parameters<BlockEmitter["emit"]>[2], state: NodeBuildState, ctx: NodeEmitContext) {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.resolve(block, inputName, stage, state);
    }
    const raw = block.serialized[fallbackKey];
    const n = typeof raw === "number" ? raw : 0;
    return { expr: `${formatFloat(n)}`, type: "f32" as NodeValueType };
}

export function formatFloat(n: number): string {
    if (!Number.isFinite(n)) {
        return "0.0";
    }
    const s = n.toString();
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}
