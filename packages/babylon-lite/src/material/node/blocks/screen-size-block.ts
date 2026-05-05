/** ScreenSizeBlock — exposes current render size in physical canvas pixels. */

import type { BlockEmitter, NodeValueType } from "../node-types.js";

const OUTPUTS: Record<string, { readonly swizzle: string; readonly type: NodeValueType }> = {
    xy: { swizzle: "", type: "vec2f" },
    x: { swizzle: ".x", type: "f32" },
    y: { swizzle: ".y", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "ScreenSizeBlock",
    stage: "fragment",
    emit(_block, outputName, _stage, state) {
        state.usesScreenSize = true;
        const out = OUTPUTS[outputName];
        if (!out) {
            throw new Error(`NodeMaterial: ScreenSizeBlock has no output "${outputName}"`);
        }
        return { expr: `_NME_SCREEN_SIZE_${out.swizzle}`, type: out.type };
    },
};
