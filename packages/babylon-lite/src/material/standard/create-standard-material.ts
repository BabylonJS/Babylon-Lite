import type { StandardMaterialProps } from "./standard-material.js";
import { standardGroupBuilder } from "./standard-group-builder.js";

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
        emissiveTexture: null,
        bumpTexture: null,
        bumpLevel: 1,
        specularTexture: null,
        specularCoordIndex: 0,
        ambientTexture: null,
        ambientTexLevel: 1,
        ambientCoordIndex: 0,
        lightmapTexture: null,
        lightmapLevel: 1,
        lightmapCoordIndex: 1,
        useLightmapAsShadowmap: false,
        opacityTexture: null,
        opacityLevel: 1,
        opacityFromRGB: false,
        alphaCutOff: 0,
        reflectionTexture: null,
        reflectionCubeTexture: null,
        reflectionLevel: 1,
        reflectionCoordMode: 1,
        uvScale: [1, 1],
        backFaceCulling: true,
        disableLighting: false,
        _buildGroup: standardGroupBuilder,
        _uboVersion: 0,
    } as StandardMaterialProps;
}
