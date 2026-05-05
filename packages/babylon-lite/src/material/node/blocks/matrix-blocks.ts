/** Matrix operation emitters.
 *
 * Supports MatrixBuilder, MatrixSplitterBlock, MatrixTransposeBlock, and
 * MatrixDeterminantBlock. Babylon.js' WGSL MatrixBuilder path emits
 * `mat4x4f(row0, row1, row2, row3)`; WGSL matrix constructors take column
 * vectors, so Lite follows that exact constructor ordering.
 */

import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, NodeExpr, NodeValueType, Stage } from "../node-types.js";

const SPLIT_OUTPUT: Record<string, { readonly expr: (input: string) => string; readonly type: NodeValueType }> = {
    row0: { expr: (input) => `(${input})[0]`, type: "vec4f" },
    row1: { expr: (input) => `(${input})[1]`, type: "vec4f" },
    row2: { expr: (input) => `(${input})[2]`, type: "vec4f" },
    row3: { expr: (input) => `(${input})[3]`, type: "vec4f" },
    col0: { expr: (input) => `vec4<f32>((${input})[0][0], (${input})[1][0], (${input})[2][0], (${input})[3][0])`, type: "vec4f" },
    col1: { expr: (input) => `vec4<f32>((${input})[0][1], (${input})[1][1], (${input})[2][1], (${input})[3][1])`, type: "vec4f" },
    col2: { expr: (input) => `vec4<f32>((${input})[0][2], (${input})[1][2], (${input})[2][2], (${input})[3][2])`, type: "vec4f" },
    col3: { expr: (input) => `vec4<f32>((${input})[0][3], (${input})[1][3], (${input})[2][3], (${input})[3][3])`, type: "vec4f" },
};

function optionalVec4(block: NodeBlock, inputName: string, fallback: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): string {
    const input = block.inputs.get(inputName);
    if (!input?.source) {
        return fallback;
    }
    return ctx.cast(ctx.resolve(block, inputName, stage, state), "vec4f").expr;
}

function emitMatrixBuilder(block: NodeBlock, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr {
    const row0 = optionalVec4(block, "row0", "vec4<f32>(1.0, 0.0, 0.0, 0.0)", stage, state, ctx);
    const row1 = optionalVec4(block, "row1", "vec4<f32>(0.0, 1.0, 0.0, 0.0)", stage, state, ctx);
    const row2 = optionalVec4(block, "row2", "vec4<f32>(0.0, 0.0, 1.0, 0.0)", stage, state, ctx);
    const row3 = optionalVec4(block, "row3", "vec4<f32>(0.0, 0.0, 0.0, 1.0)", stage, state, ctx);
    return { expr: `mat4x4<f32>(${row0}, ${row1}, ${row2}, ${row3})`, type: "mat4f" };
}

export const emitter: BlockEmitter = {
    className: "MatrixBlocks",
    emit(block, outputName, stage, state, ctx) {
        if (block.className === "MatrixBuilder") {
            return emitMatrixBuilder(block, stage, state, ctx);
        }
        const input = ctx.cast(ctx.resolve(block, "input", stage, state), "mat4f");
        if (block.className === "MatrixTransposeBlock") {
            return { expr: `transpose(${input.expr})`, type: "mat4f" };
        }
        if (block.className === "MatrixDeterminantBlock") {
            return { expr: `determinant(${input.expr})`, type: "f32" };
        }
        if (block.className === "MatrixSplitterBlock") {
            const output = SPLIT_OUTPUT[outputName];
            if (!output) {
                throw new Error(`NodeMaterial: MatrixSplitterBlock has no output "${outputName}"`);
            }
            return { expr: output.expr(input.expr), type: output.type };
        }
        throw new Error(`NodeMaterial: unsupported matrix block "${block.className}"`);
    },
};
