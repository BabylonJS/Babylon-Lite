import type { Texture2D } from "../../texture/texture-2d.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _getPbrExts } from "./pbr-flags.js";

/** Collect all non-null textures referenced by a PBR material, including registered extensions. */
export function collectPbrBoundTextures(mat: PbrMaterialProps): Texture2D[] {
    const textures: Texture2D[] = [];
    for (const texture of [mat.baseColorTexture, mat.normalTexture, mat.ormTexture, mat.occlusionTexture, mat.emissiveTexture, mat.specGlossTexture]) {
        if (texture) {
            textures.push(texture);
        }
    }
    for (const extension of _getPbrExts().values()) {
        extension.textures?.(mat, textures);
    }
    return textures;
}
