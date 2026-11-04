import type { Texture2D } from "../texture/texture-2d.js";
import { acquireGPUTexture } from "./gpu-texture-acquire.js";

/** Increment ref count on a Texture2D. First acquire sets count to one. */
export function acquireTexture(texture: Texture2D): void {
    acquireGPUTexture(texture.texture);
}
