/** TextureBlock — samples a 2D texture.
 *
 *  Inputs:
 *    - `uv`: vec2 texture coordinates.
 *    - `source` (optional): ImageSourceBlock.output that names the binding. When
 *      absent, this block owns its own binding named after itself.
 *  Outputs: `rgba`, `rgb`, `r`, `g`, `b`, `a`, `level`.
 */

import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";

const OUTPUT: Record<string, { swizzle: string; type: NodeValueType }> = {
    rgba: { swizzle: "", type: "vec4f" },
    rgb: { swizzle: ".xyz", type: "vec3f" },
    r: { swizzle: ".x", type: "f32" },
    g: { swizzle: ".y", type: "f32" },
    b: { swizzle: ".z", type: "f32" },
    a: { swizzle: ".w", type: "f32" },
};

function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export const emitter: BlockEmitter = {
    className: "TextureBlock",
    emit(block, outputName, stage, state, ctx) {
        // Resolve source binding: if `source` input is connected, use that producer's name;
        // otherwise name the binding after this block.
        let bindingName: string;
        const source = block.inputs.get("source");
        if (source?.source) {
            const producer = ctx.graph.blocks.get(source.source.blockId);
            bindingName = sanitize(producer?.name || `tex${block.id}`);
        } else {
            bindingName = sanitize(block.name || `tex${block.id}`);
        }

        // Dedup binding.
        if (!state.textures.find((t) => t.name === bindingName)) {
            state.textures.push({ name: bindingName, kind: "texture2d", texture: null });
        }

        // Resolve UV.
        const uvInput = block.inputs.get("uv");
        let uv: NodeExpr;
        if (uvInput?.source) {
            uv = ctx.cast(ctx.resolve(block, "uv", stage, state), "vec2f");
        } else {
            // Fallback: a zero UV so shader still compiles (matches BJS behaviour when unhooked).
            uv = { expr: "vec2<f32>(0.0, 0.0)", type: "vec2f" };
        }

        // Memoize the full sample per-stage so rgba/rgb/r/... share one textureSample call.
        const memoKey = `_tex_${block.id}_sample`;
        const stageState = stage === "vertex" ? state.vertex : state.fragment;
        let sampleExpr = stageState.memo.get(memoKey);
        if (!sampleExpr) {
            const sampleVar = `_s${ctx.temp(state, "tex")}`;
            stageState.body.push(`let ${sampleVar} = textureSample(nodeTex_${bindingName}, nodeSamp_${bindingName}, ${uv.expr});`);
            sampleExpr = { expr: sampleVar, type: "vec4f" };
            stageState.memo.set(memoKey, sampleExpr);
        }

        // Special case: `level` output returns a pseudo-f32 (0.0 for now — proper LOD calc TBD).
        if (outputName === "level") {
            return { expr: "0.0", type: "f32" };
        }

        const out = OUTPUT[outputName] ?? OUTPUT.rgba!;
        return { expr: `${sampleExpr.expr}${out.swizzle}`, type: out.type };
    },
};
