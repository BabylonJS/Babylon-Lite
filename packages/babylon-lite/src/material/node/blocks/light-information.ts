/** LightInformationBlock — exposes a specific light's direction / color / intensity.
 *
 *  BJS picks the light by index (serialized as `lightId` or picked default 0).
 *  We emit references to the scene's Lights UBO entries; the pipeline builder
 *  binds `nmeLights[i]` at the reserved slot.
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "LightInformationBlock",
    emit(block, outputName, _stage, _state, _ctx) {
        const idxRaw = block.serialized.lightId;
        const idx = typeof idxRaw === "number" ? idxRaw : 0;
        const base = `nmeLights[${idx}u]`;
        const out: Record<string, NodeExpr> = {
            direction: { expr: `${base}.direction.xyz`, type: "vec3f" },
            color: { expr: `${base}.color.rgb`, type: "vec3f" },
            intensity: { expr: `${base}.color.a`, type: "f32" },
        };
        return out[outputName] ?? out.direction!;
    },
};
