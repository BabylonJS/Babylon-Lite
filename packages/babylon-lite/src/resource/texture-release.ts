import type { Texture2D } from "../texture/texture-2d.js";
import { releaseTextureAllocation } from "./texture-allocation-release.js";

export { _setTextureReleaseHook } from "./texture-allocation-release.js";

/** Decrement ref count on a Texture2D. Destroys, notifies, then records zero at release. */
export function releaseTexture(texture: Texture2D): boolean {
    return releaseTextureAllocation(texture.texture, texture);
}
