import type { CubeTexture } from "../../texture/cube-texture.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";

export function getStandardEmissiveTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._emissiveTexture;
}

export function getStandardBumpTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._bumpTexture;
}

export function getStandardSpecularTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._specularTexture;
}

export function getStandardAmbientTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._ambientTexture;
}

export function getStandardLightmapTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._lightmapTexture;
}

export function getStandardOpacityTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._opacityTexture;
}

export function getStandardReflectionTexture(material: StandardMaterialProps): Texture2D | null | undefined {
    return material._reflectionTexture;
}

export function getStandardReflectionCubeTexture(material: StandardMaterialProps): CubeTexture | null | undefined {
    return material._reflectionCubeTexture;
}
