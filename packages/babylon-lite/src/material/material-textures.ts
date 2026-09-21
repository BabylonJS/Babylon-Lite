import type { Material } from "./material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { getMaterialTextureBindings } from "../inspection/material-inspection.js";

/**
 * Gets the non-null 2D textures currently bound by a material.
 * @param material - Material or material view to inspect.
 * @returns A newly allocated readonly array of bound texture handles. Unknown material families return an empty array.
 */
export function getMaterialTextures(material: Material): readonly Texture2D[] {
    const textures: Texture2D[] = [];
    for (const binding of getMaterialTextureBindings(material)) {
        if (binding.value.state === "present" && (binding.value.value.kind === "2d" || binding.value.value.kind === "2d-array")) {
            textures.push(binding.value.value.entity as Texture2D);
        }
    }
    return textures;
}
