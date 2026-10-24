/** KHR_materials_specular writer. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, hasTx, setUnlessDefault, setVecUnlessDefault } from "../export-material-slots.js";

export const specularWriter: MaterialExtensionWriter = {
    name: "KHR_materials_specular",
    write(ctx, material, out, uvState) {
        const w = material._specularWeight ?? material._metallicF0Factor ?? 1;
        const c = material._metallicReflectanceColor ?? [1, 1, 1];
        const specTex = material._metallicReflectanceTexture;
        const colorTex = material._reflectanceTexture;
        const white = c[0] === 1 && c[1] === 1 && c[2] === 1;
        if (w === 1 && white && !specTex && !colorTex) {
            return;
        }
        const payload: GltfJsonObject = {};
        const transform = hasTx(specTex) || hasTx(colorTex);
        setUnlessDefault(payload, "specularFactor", w, 1);
        capturePbrSlot(ctx, material, uvState, payload, { key: "specularTexture", texture: specTex, transform });
        setVecUnlessDefault(payload, "specularColorFactor", c, [1, 1, 1]);
        capturePbrSlot(ctx, material, uvState, payload, { key: "specularColorTexture", texture: colorTex, transform });
        attachExtension(ctx, out, "KHR_materials_specular", payload);
    },
};
