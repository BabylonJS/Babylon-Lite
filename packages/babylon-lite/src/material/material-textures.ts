import type { Texture2D } from "../texture/texture-2d.js";
import { getMaterialFamily } from "./material-family.js";
import type { Material } from "./material.js";
import { getMaterialSource } from "./material-view.js";
import type { NodeMaterial } from "./node/node-material.js";
import {
    getPbrAnisotropy,
    getPbrClearCoat,
    getPbrIridescence,
    getPbrMetallicReflectance,
    getPbrSheen,
    getPbrSubsurface,
    getPbrTransmission,
} from "./pbr/pbr-material-accessors.js";
import type { PbrMaterialProps } from "./pbr/pbr-material.js";
import { getShaderTexture, type ShaderMaterial } from "./shader/shader-material.js";
import {
    getStandardAmbientTexture,
    getStandardBumpTexture,
    getStandardEmissiveTexture,
    getStandardLightmapTexture,
    getStandardOpacityTexture,
    getStandardReflectionTexture,
    getStandardSpecularTexture,
} from "./standard/standard-material-accessors.js";
import type { StandardMaterialProps } from "./standard/standard-material.js";

/**
 * Gets the non-null 2D textures currently bound by a material.
 * @param material - Material or material view to inspect.
 * @returns A newly allocated readonly array. Unknown material families return an empty array.
 */
export function getMaterialTextures(material: Material): readonly Texture2D[] {
    const source = getMaterialSource(material);
    switch (getMaterialFamily(source)) {
        case "standard":
            return getStandardTextures(source as StandardMaterialProps);
        case "pbr":
            return getPbrTextures(source as PbrMaterialProps);
        case "shader":
            return getShaderTextures(source as ShaderMaterial);
        case "node":
            return getNodeTextures((source as NodeMaterial).inputs);
        default:
            return [];
    }
}

function getStandardTextures(material: StandardMaterialProps): readonly Texture2D[] {
    const textures: Texture2D[] = [];
    pushTexture(textures, material.diffuseTexture);
    pushTexture(textures, getStandardEmissiveTexture(material));
    pushTexture(textures, getStandardBumpTexture(material));
    pushTexture(textures, getStandardSpecularTexture(material));
    pushTexture(textures, getStandardAmbientTexture(material));
    pushTexture(textures, getStandardLightmapTexture(material));
    pushTexture(textures, getStandardOpacityTexture(material));
    pushTexture(textures, getStandardReflectionTexture(material));
    return textures;
}

function getPbrTextures(material: PbrMaterialProps): readonly Texture2D[] {
    const textures: Texture2D[] = [];
    for (const texture of [
        material.baseColorTexture,
        material.normalTexture,
        material.ormTexture,
        material.occlusionTexture,
        material.emissiveTexture,
        material.specGlossTexture,
        material.lightmapTexture,
    ]) {
        pushTexture(textures, texture);
    }

    const reflectance = getPbrMetallicReflectance(material);
    pushTexture(textures, reflectance?.texture);
    pushTexture(textures, reflectance?.reflectanceTexture);

    const clearCoat = getPbrClearCoat(material);
    pushTexture(textures, clearCoat?.texture);
    pushTexture(textures, clearCoat?.roughnessTexture);
    pushTexture(textures, clearCoat?.bumpTexture);

    const sheen = getPbrSheen(material);
    pushTexture(textures, sheen?.texture);
    pushTexture(textures, sheen?.roughnessTexture);

    const iridescence = getPbrIridescence(material);
    pushTexture(textures, iridescence?.texture);
    pushTexture(textures, iridescence?.thicknessTexture);

    pushTexture(textures, getPbrAnisotropy(material)?.texture);

    const subsurface = getPbrSubsurface(material);
    pushTexture(textures, subsurface?.translucency?.colorTexture);
    pushTexture(textures, subsurface?.translucency?.intensityTexture);
    pushTexture(textures, subsurface?.thickness?.texture);
    pushTexture(textures, getPbrTransmission(material)?.texture);
    return textures;
}

function getShaderTextures(material: ShaderMaterial): readonly Texture2D[] {
    const textures: Texture2D[] = [];
    for (const declaration of material.samplerDecls) {
        pushTexture(textures, getShaderTexture(material, declaration.name));
    }
    return textures;
}

function getNodeTextures(inputs: NodeMaterial["inputs"]): readonly Texture2D[] {
    const textures: Texture2D[] = [];
    for (const name in inputs) {
        if (Object.hasOwn(inputs, name)) {
            const input = inputs[name]!;
            if (input.type === "texture2d") {
                pushTexture(textures, input.texture);
            }
        }
    }
    return textures;
}

function pushTexture(textures: Texture2D[], texture: Texture2D | null | undefined): void {
    if (texture) {
        textures.push(texture);
    }
}
