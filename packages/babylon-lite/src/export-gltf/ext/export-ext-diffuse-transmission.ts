/** KHR_materials_diffuse_transmission writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, setUnlessDefault, setVecUnlessDefault } from "../export-material-slots.js";

export const diffuseTransmissionWriter: MaterialExtensionWriter = {
    name: "KHR_materials_diffuse_transmission",
    write(ctx, material, out, uvState) {
        const ss = material._subsurface;
        const t = ss?.translucency;
        if (t === undefined || ss?.thickness?.min !== 0 || ss.thickness.max !== 0) {
            return;
        }
        const payload: GltfJsonObject = {};
        const transform = hasTx(t.intensityTexture) || hasTx(t.colorTexture);
        setUnlessDefault(payload, "diffuseTransmissionFactor", t.intensity ?? 1, 0);
        capturePbrSlot(ctx, material, uvState, payload, { key: "diffuseTransmissionTexture", texture: t.intensityTexture, transform });
        if (t.color) {
            setVecUnlessDefault(payload, "diffuseTransmissionColorFactor", t.color, [1, 1, 1]);
        }
        capturePbrSlot(ctx, material, uvState, payload, { key: "diffuseTransmissionColorTexture", texture: t.colorTexture, transform });
        attachExtension(ctx, out, "KHR_materials_diffuse_transmission", payload);
    },
};
