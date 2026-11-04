/** KHR_materials_pbrSpecularGlossiness writer. With a spec-gloss texture Lite ignores the specular
 *  and glossiness factors, so only the textures and the resolved diffuse factor are written. */

import type { MaterialExtensionWriter } from "../export-context.js";
import { attachExtension } from "../export-context.js";
import type { GltfJsonObject } from "../export-gltf-types.js";
import { capturePbrSlot, isOneByOne, pbrCoreSlot, UV2_BASE_COLOR, UV2_SPEC_GLOSS } from "../export-material-slots.js";

export const specGlossWriter: MaterialExtensionWriter = (ctx, material, out, uvState) => {
    if (!material.specGlossTexture) {
        return;
    }
    const p: GltfJsonObject = {};
    attachExtension(ctx, out, "KHR_materials_pbrSpecularGlossiness", p);
    if (!isOneByOne(material.baseColorTexture)) {
        capturePbrSlot(ctx, material, uvState, p, {
            ...pbrCoreSlot(material, "diffuseTexture", material.baseColorTexture, UV2_BASE_COLOR),
            colorDecode: material._gammaAlbedo ? "gamma" : "linear",
        });
    }
    capturePbrSlot(ctx, material, uvState, p, { ...pbrCoreSlot(material, "specularGlossinessTexture", material.specGlossTexture, UV2_SPEC_GLOSS), colorDecode: "linear" });
    ctx.afterResolve.push(() => {
        const f = out.pbrMetallicRoughness?.baseColorFactor;
        if (f) {
            p.diffuseFactor = Array.from(f);
        }
    });
};
