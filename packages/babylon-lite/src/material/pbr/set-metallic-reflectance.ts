/** Metallic-reflectance PBR material opt-in (KHR_materials_specular family).
 *
 *  Statically imports the reflectance fragment's `pbrExt`; the fragment plus its wiring
 *  bundle only when an app imports `setPbrMetallicReflectance` (or the glTF dielectric
 *  handler, which registers the same ext). No always-loaded `metallicReflectance` scan
 *  or fragment import specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { pbrExt } from "./fragments/reflectance-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Options for {@link setPbrMetallicReflectance}. Mirrors the dielectric-reflectance
 *  fields of `PbrMaterialProps` (BJS metallicReflectance* / KHR_materials_specular). */
export interface MetallicReflectanceOptions {
    /** Linear-RGB tint for dielectric reflectance (BJS metallicReflectanceColor). */
    color?: [number, number, number];
    /** RGB tints reflectance, A scales F0 (BJS metallicReflectanceTexture). */
    texture?: Texture2D;
    /** RGB tints reflectance only (BJS reflectanceTexture). */
    reflectanceTexture?: Texture2D;
    /** Scales dielectric F0 (BJS metallicF0Factor). */
    f0Factor?: number;
    /** Grazing specular/F90 weight. */
    specularWeight?: number;
    /** When true + both reflectance textures set, texture only contributes A (F0 scalar). */
    useOnlyMetallicFromTexture?: boolean;
}

/** Apply dielectric reflectance controls to `mat`. Registers the reflectance extension
 *  globally (idempotent). Call before the scene is first built. */
export function setPbrMetallicReflectance(mat: Partial<PbrMaterialProps>, options: MetallicReflectanceOptions): void {
    if (options.color) {
        mat.metallicReflectanceColor = options.color;
    }
    if (options.texture) {
        mat.metallicReflectanceTexture = options.texture;
    }
    if (options.reflectanceTexture) {
        mat.reflectanceTexture = options.reflectanceTexture;
    }
    if (options.f0Factor !== undefined) {
        mat.metallicF0Factor = options.f0Factor;
    }
    if (options.specularWeight !== undefined) {
        mat.specularWeight = options.specularWeight;
    }
    if (options.useOnlyMetallicFromTexture !== undefined) {
        mat.useOnlyMetallicFromMetallicReflectanceTexture = options.useOnlyMetallicFromTexture;
    }
    _registerPbrExt(pbrExt);
}
