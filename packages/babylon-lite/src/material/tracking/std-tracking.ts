/** Standard material auto-dirty tracking. Dynamically imported by enableMaterialTracking(). */

import type { StandardMaterialProps } from "../standard/standard-material.js";
import { trackScalar, observableColor3, observableVec2 } from "./tracking-primitives.js";

export function installStdTracking(mat: StandardMaterialProps): void {
    for (const key of ["alpha", "specularPower", "roughness", "bumpLevel", "ambientTexLevel", "lightmapLevel", "opacityLevel", "alphaCutOff", "reflectionLevel"]) {
        trackScalar(mat, key);
    }
    mat.diffuseColor = observableColor3(mat.diffuseColor[0], mat.diffuseColor[1], mat.diffuseColor[2], mat as any);
    mat.specularColor = observableColor3(mat.specularColor[0], mat.specularColor[1], mat.specularColor[2], mat as any);
    mat.emissiveColor = observableColor3(mat.emissiveColor[0], mat.emissiveColor[1], mat.emissiveColor[2], mat as any);
    mat.ambientColor = observableColor3(mat.ambientColor[0], mat.ambientColor[1], mat.ambientColor[2], mat as any);
    mat.uvScale = observableVec2(mat.uvScale[0], mat.uvScale[1], mat as any);
}
