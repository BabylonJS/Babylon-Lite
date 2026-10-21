/** KHR_materials_volume writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, setUnlessDefault, setVecUnlessDefault } from "../export-material-slots.js";

export const volumeWriter: MaterialExtensionWriter = {
    name: "KHR_materials_volume",
    write(ctx, material, out, uvState) {
        const ss = material._subsurface;
        if (!(ss?.thickness?.useGlTFChannel === true || (ss?.tint !== undefined && ss.thickness === undefined))) {
            return;
        }
        const payload: GltfJsonObject = {};
        if (ss.thickness) {
            setUnlessDefault(payload, "thicknessFactor", ss.thickness.max ?? 1, 0);
        }
        capturePbrSlot(ctx, material, uvState, payload, { key: "thicknessTexture", texture: ss.thickness?.texture, transform: material._transmissive === true });
        const tint = ss.tint;
        if (tint) {
            const color = tint.color;
            // The loader's synthesized no-absorption tint: white (or unset) at distance 1.
            const synthesized = tint.atDistance === 1 && (!color || (Math.abs(color[0] - 1) <= 1e-6 && Math.abs(color[1] - 1) <= 1e-6 && Math.abs(color[2] - 1) <= 1e-6));
            if (!synthesized) {
                if (tint.atDistance !== undefined && tint.atDistance > 0) {
                    payload.attenuationDistance = tint.atDistance;
                }
                if (color) {
                    setVecUnlessDefault(payload, "attenuationColor", color, [1, 1, 1]);
                }
            }
        }
        attachExtension(ctx, out, "KHR_materials_volume", payload);
    },
};
