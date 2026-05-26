import type { Texture2D } from "../../texture/texture-2d.js";
import { _getStdExts } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";

/** Collect all non-null textures referenced by a Standard material (for acquire/release). */
export function collectStdBoundTextures(mat: StandardMaterialProps): Texture2D[] {
    const t: Texture2D[] = [];
    if (mat.diffuseTexture) {
        t.push(mat.diffuseTexture);
    }
    for (const ext of _getStdExts().values()) {
        ext._textures?.(mat, t);
    }
    return t;
}
