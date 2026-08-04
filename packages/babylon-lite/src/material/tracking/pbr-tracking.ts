/** PBR material auto-dirty tracking. Dynamically imported by enableMaterialTracking(). */

import type { PbrMaterialProps, SheenProps } from "../pbr/pbr-material.js";
import { trackScalar, trackSubProps, observableColor3 } from "./tracking-primitives.js";

export function installPbrTracking(mat: PbrMaterialProps): void {
    for (const key of ["alpha", "environmentIntensity", "directIntensity", "reflectance", "occlusionStrength", "_metallicF0Factor"]) {
        if ((mat as any)[key] !== undefined) {
            trackScalar(mat, key);
        }
    }
    if (mat.emissiveColor) {
        mat.emissiveColor = observableColor3(mat.emissiveColor[0], mat.emissiveColor[1], mat.emissiveColor[2], mat as any);
    }
    if (mat._metallicReflectanceColor) {
        mat._metallicReflectanceColor = observableColor3(mat._metallicReflectanceColor[0], mat._metallicReflectanceColor[1], mat._metallicReflectanceColor[2], mat as any);
    }
    if (mat._anisotropy) {
        trackSubProps(mat as any, mat._anisotropy, ["intensity"]);
    }
    if (mat._clearCoat) {
        trackSubProps(mat as any, mat._clearCoat, ["intensity", "roughness", "indexOfRefraction"]);
    }
    if (mat._sheen) {
        const sh = mat._sheen as SheenProps;
        trackSubProps(mat as any, sh, ["intensity", "roughness"]);
        if (sh.color) {
            sh.color = observableColor3(sh.color[0]!, sh.color[1]!, sh.color[2]!, mat as any);
        }
    }
}
