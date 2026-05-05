/** MeshAttributeExistsBlock — per-mesh attribute branch.
 *
 * Babylon.js emits preprocessor branches based on the mesh attribute defines
 * (`UV1`, `TANGENT`, `VERTEXCOLOR_NME`, ...). Babylon Lite batches meshes that
 * share the same NME pipeline, so the equivalent decision is a per-mesh uniform
 * flag written beside the world matrix. Missing attributes still bind zero
 * buffers to satisfy the pipeline layout, but this block selects the serialized
 * fallback value when the real mesh attribute is absent.
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";

function attributeFlag(attributeType: number): string | null {
    switch (attributeType) {
        case 1: // Normal
            return "1.0";
        case 2: // Tangent
            return "meshU.receivesShadow.z";
        case 3: // VertexColor
            return "meshU.receivesShadow.w";
        case 4: // UV1
            return "meshU.receivesShadow.y";
        case 5: // UV2
            return "0.0";
        case 6: // UV3
        case 7: // UV4
        case 8: // UV5
        case 9: // UV6
            return "0.0";
        default:
            return null;
    }
}

export const emitter: BlockEmitter = {
    className: "MeshAttributeExistsBlock",
    emit(block, _outputName, stage, state, ctx) {
        state.usesMeshAttributeExists = true;
        const input = ctx.resolve(block, "input", stage, state);
        const flag = attributeFlag((block.serialized["attributeType"] as number | undefined) ?? 0);
        if (flag === null) {
            return input;
        }
        const fallback = ctx.cast(ctx.resolve(block, "fallback", stage, state), input.type);
        const expr = ctx.temp(state, "attr");
        const s = stage === "vertex" ? state.vertex : state.fragment;
        s.body.push(`let ${expr} = select(${fallback.expr}, ${input.expr}, ${flag} > 0.5);`);
        return { expr, type: input.type } as NodeExpr;
    },
};
