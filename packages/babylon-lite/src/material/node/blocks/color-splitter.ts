/** ColorSplitterBlock — identical to VectorSplitter but with r/g/b/a naming. */

import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";

const COMPONENT: Record<string, { swizzle: string; type: NodeValueType }> = {
    rgba: { swizzle: "", type: "vec4f" },
    rgb: { swizzle: ".xyz", type: "vec3f" },
    r: { swizzle: ".x", type: "f32" },
    g: { swizzle: ".y", type: "f32" },
    b: { swizzle: ".z", type: "f32" },
    a: { swizzle: ".w", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "ColorSplitterBlock",
    emit(block, outputName, stage, state, ctx) {
        let source: NodeExpr | null = null;
        for (const key of ["rgba", "rgb"] as const) {
            if (block.inputs.get(key)?.source) {
                source = ctx.resolve(block, key, stage, state);
                break;
            }
        }
        if (!source) {
            throw new Error(`NodeMaterial: ColorSplitterBlock (id=${block.id}) has no connected input`);
        }
        const c = COMPONENT[outputName];
        if (!c) {
            throw new Error(`NodeMaterial: ColorSplitterBlock has no output "${outputName}"`);
        }
        return { expr: `(${source.expr})${c.swizzle}`, type: c.type };
    },
};
