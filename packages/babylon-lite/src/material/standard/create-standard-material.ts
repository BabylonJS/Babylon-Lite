import type { StandardMaterialProps } from "./standard-material.js";
import { getStandardGroupBuilder } from "./standard-group-builder.js";

/** Create StandardMaterial with Babylon defaults. */
export function createStandardMaterial(): StandardMaterialProps {
    return {
        diffuseColor: [1, 1, 1],
        alpha: 1,
        specularColor: [1, 1, 1],
        specularPower: 64,
        emissiveColor: [0, 0, 0],
        ambientColor: [0, 0, 0],
        diffuseTexture: null,
        diffuseCoordIndex: 0,
        bumpLevel: 1,
        specularCoordIndex: 0,
        ambientTexLevel: 1,
        ambientCoordIndex: 0,
        lightmapLevel: 1,
        lightmapCoordIndex: 1,
        useLightmapAsShadowmap: false,
        opacityLevel: 1,
        opacityFromRGB: false,
        alphaCutOff: 0,
        reflectionLevel: 1,
        reflectionCoordMode: 1,
        uvScale: [1, 1],
        backFaceCulling: true,
        disableLighting: false,
        _buildGroup: getStandardGroupBuilder(),
        _uboVersion: 0,
    } as StandardMaterialProps;
}
