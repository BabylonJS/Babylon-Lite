/** KHR_materials_anisotropy writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, setUnlessDefault } from "../export-material-slots.js";

export const anisotropyWriter: MaterialExtensionWriter = (ctx, material, out, uvState) => {
    const an = material._anisotropy;
    if (an?.isEnabled !== true) {
        return;
    }
    const payload: GltfJsonObject = {};
    setUnlessDefault(payload, "anisotropyStrength", an.intensity ?? 1, 0);
    const d = an.direction ?? [1, 0];
    setUnlessDefault(payload, "anisotropyRotation", Math.atan2(d[1], d[0]), 0);
    capturePbrSlot(ctx, material, uvState, payload, { key: "anisotropyTexture", texture: an.texture, transform: true });
    attachExtension(ctx, out, "KHR_materials_anisotropy", payload);
};
