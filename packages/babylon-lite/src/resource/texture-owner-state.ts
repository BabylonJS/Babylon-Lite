import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureReferenceStore } from "./texture-reference-store.js";

/** Whether every owner released this Texture2D's current GPUTexture. */
export function _isTextureReleased(texture: Texture2D): boolean {
    return getTextureReferenceStore().get(texture.texture) === 0;
}

/** Number of owners holding this Texture2D's current GPUTexture. */
export function _textureOwners(texture: Texture2D): number {
    return getTextureReferenceStore().get(texture.texture) ?? 0;
}
