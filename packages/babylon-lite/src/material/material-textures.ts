import type { Material } from "./material.js";
import type { NodeMaterial } from "./node/node-material.js";
import type { PbrMaterialProps } from "./pbr/pbr-material.js";
import type { ShaderMaterial } from "./shader/shader-material.js";
import type { StandardMaterialProps } from "./standard/standard-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { getMaterialFamily } from "./material-family.js";
import { getMaterialSource } from "./material-view.js";
import { collectPbrBoundTextures } from "./pbr/pbr-material.js";
import { collectStdBoundTextures } from "./standard/collect-std-bound-textures.js";

/**
 * Gets the non-null 2D textures currently bound by a material.
 * @param material - Material or material view to inspect.
 * @returns A newly allocated readonly array of bound texture handles. Unknown material families return an empty array.
 */
export function getMaterialTextures(material: Material): readonly Texture2D[] {
    const source = getMaterialSource(material);
    switch (getMaterialFamily(source)) {
        case "pbr":
            return collectPbrBoundTextures(source as PbrMaterialProps);
        case "standard":
            return collectStdBoundTextures(source as StandardMaterialProps);
        case "shader":
            return getSlotTextures((source as ShaderMaterial)._textureSlots.values());
        case "node":
            return getNodeTextures((source as NodeMaterial).inputs);
        default:
            return [];
    }
}

function getNodeTextures(inputs: NodeMaterial["inputs"]): Texture2D[] {
    const textures: Texture2D[] = [];
    for (const name in inputs) {
        if (Object.hasOwn(inputs, name)) {
            const input = inputs[name]!;
            if (input.type === "texture2d" && input.texture) {
                textures.push(input.texture);
            }
        }
    }
    return textures;
}

function getSlotTextures(slots: Iterable<{ readonly current: Texture2D | null }>): Texture2D[] {
    const textures: Texture2D[] = [];
    for (const slot of slots) {
        if (slot.current) {
            textures.push(slot.current);
        }
    }
    return textures;
}
