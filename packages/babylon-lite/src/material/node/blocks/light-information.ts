/** LightInformationBlock — exposes a specific light's direction / color / intensity.
 *
 *  BJS picks the light by index (serialized as `lightId` or picked default 0).
 *  The pipeline builder binds the scene's shared lights UBO under `nmeLights`
 *  (an array of `LightEntry` in `lightsUniforms`).
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "LightInformationBlock",
    emit(block, outputName, _stage, state, _ctx) {
        state.usesLightsUbo = true;
        const idxRaw = block.serialized.lightId;
        const idx = typeof idxRaw === "number" ? idxRaw : 0;
        const base = `nmeLights.lights[nli(${idx}u)]`;
        const out: Record<string, NodeExpr> = {
            direction: { expr: `${base}.vLightData.xyz`, type: "vec3f" },
            color: { expr: `${base}.vLightDiffuse.rgb`, type: "vec3f" },
            intensity: { expr: `${base}.vLightDiffuse.a`, type: "f32" },
        };
        return out[outputName] ?? out.direction!;
    },
};
