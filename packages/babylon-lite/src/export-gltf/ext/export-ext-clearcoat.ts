/** KHR_materials_clearcoat writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, materialLabel, setUnlessDefault } from "../export-material-slots.js";

export const clearcoatWriter: MaterialExtensionWriter = (ctx, material, out, uvState) => {
    const cc = material._clearCoat;
    if (cc?.isEnabled !== true) {
        return;
    }
    const name = materialLabel(material);
    const ior = cc.indexOfRefraction ?? 1.5;
    if (ior !== 1.5) {
        ctx.warn(`Material "${name}" has a clearcoat index of refraction of ${ior}, which KHR_materials_clearcoat cannot represent; exporting it as 1.5.`);
    }
    if (cc.useF0Remap !== false) {
        ctx.warn(`Material "${name}" remaps F0 under its clearcoat, which KHR_materials_clearcoat cannot represent; exporting without the remap.`);
    }
    const payload: GltfJsonObject = {};
    const transform = hasTx(cc.texture) || hasTx(cc.roughnessTexture) || hasTx(cc.bumpTexture);
    setUnlessDefault(payload, "clearcoatFactor", cc.intensity ?? 1, 0);
    capturePbrSlot(ctx, material, uvState, payload, { key: "clearcoatTexture", texture: cc.texture, transform });
    setUnlessDefault(payload, "clearcoatRoughnessFactor", cc.roughness ?? 0, 0);
    capturePbrSlot(ctx, material, uvState, payload, { key: "clearcoatRoughnessTexture", texture: cc.roughnessTexture, transform });
    const scale = cc.bumpTextureScale ?? 1;
    capturePbrSlot(ctx, material, uvState, payload, {
        key: "clearcoatNormalTexture",
        texture: cc.bumpTexture,
        transform,
        extra: scale !== 1 ? { scale } : undefined,
    });
    attachExtension(ctx, out, "KHR_materials_clearcoat", payload);
};
