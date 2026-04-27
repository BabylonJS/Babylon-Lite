/** VectorSplitterBlock — splits a vector into sub-vectors / components. */

import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";

const COMPONENT: Record<string, { swizzle: string; type: NodeValueType }> = {
    xyzw: { swizzle: "", type: "vec4f" },
    xyz: { swizzle: ".xyz", type: "vec3f" },
    xy: { swizzle: ".xy", type: "vec2f" },
    x: { swizzle: ".x", type: "f32" },
    y: { swizzle: ".y", type: "f32" },
    z: { swizzle: ".z", type: "f32" },
    w: { swizzle: ".w", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "VectorSplitterBlock",
    emit(block, outputName, stage, state, ctx) {
        // Pick the widest connected input: xyzw > xyz > xy
        let source: NodeExpr | null = null;
        for (const key of ["xyzw", "xyz", "xy"] as const) {
            if (block.inputs.get(key)?.source) {
                source = ctx.resolve(block, key, stage, state);
                break;
            }
        }
        if (!source) {
            throw new Error(`NodeMaterial: VectorSplitterBlock (id=${block.id}) has no connected input`);
        }
        const c = COMPONENT[outputName];
        if (!c) {
            throw new Error(`NodeMaterial: VectorSplitterBlock has no output "${outputName}"`);
        }
        return { expr: `(${source.expr})${c.swizzle}`, type: c.type };
    },
};
