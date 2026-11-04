import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureReferenceStore } from "./texture-reference-store.js";

let _textureReleaseHook: ((texture: Texture2D) => void) | null = null;

/** @internal Install the opaque release seam used by opt-in resource capture. */
export function _setTextureReleaseHook(hook: (texture: Texture2D) => void): void {
    _textureReleaseHook = hook;
}

/** @internal Release a captured allocation; facade notifications precede its retained-zero update. */
export function releaseTextureAllocation(allocation: GPUTexture, facade?: Texture2D): boolean {
    const references = getTextureReferenceStore();
    const count = (references.get(allocation) ?? 1) - 1;
    if (count <= 0) {
        allocation.destroy();
        if (facade) {
            _textureReleaseHook?.(facade);
        }
        references.set(allocation, 0);
        return true;
    }
    references.set(allocation, count);
    return false;
}
