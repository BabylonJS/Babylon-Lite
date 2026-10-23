/** KHR_materials_sheen writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, setUnlessDefault } from "../export-material-slots.js";

export const sheenWriter: MaterialExtensionWriter = (ctx, material, out, uvState) => {
    const sheen = material._sheen;
    if (sheen?.isEnabled !== true) {
        return;
    }
    const payload: GltfJsonObject = {};
    const color = sheen.color ?? [1, 1, 1];
    const k = sheen.intensity ?? 1;
    const r = color[0] * k;
    const g = color[1] * k;
    const b = color[2] * k;
    if (r !== 0 || g !== 0 || b !== 0) {
        payload.sheenColorFactor = [r, g, b];
    }
    const colorGate = hasTx(sheen.texture);
    capturePbrSlot(ctx, material, uvState, payload, {
        key: "sheenColorTexture",
        texture: sheen.texture,
        transform: colorGate,
        colorDecode: sheen.albedoScaling ? "linear" : "gamma",
    });
    setUnlessDefault(payload, "sheenRoughnessFactor", sheen.roughness ?? 0, 0);
    if (sheen.roughnessTexture) {
        capturePbrSlot(ctx, material, uvState, payload, { key: "sheenRoughnessTexture", texture: sheen.roughnessTexture, transform: true });
    } else {
        // Lite reads packed roughness from the color texture's alpha.
        capturePbrSlot(ctx, material, uvState, payload, {
            key: "sheenRoughnessTexture",
            texture: sheen.texture,
            transform: colorGate,
            colorDecode: sheen.albedoScaling ? "linear" : "gamma",
        });
    }
    attachExtension(ctx, out, "KHR_materials_sheen", payload);
};
