/** KHR_materials_transmission writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, setUnlessDefault } from "../export-material-slots.js";

export const transmissionWriter: MaterialExtensionWriter = {
    name: "KHR_materials_transmission",
    write(ctx, material, out, uvState) {
        if (material._transmissive !== true) {
            return;
        }
        const refraction = material._subsurface?.refraction;
        const payload: GltfJsonObject = {};
        setUnlessDefault(payload, "transmissionFactor", refraction?.intensity ?? 0, 0);
        capturePbrSlot(ctx, material, uvState, payload, { key: "transmissionTexture", texture: refraction?.texture, transform: true });
        attachExtension(ctx, out, "KHR_materials_transmission", payload);
    },
};
