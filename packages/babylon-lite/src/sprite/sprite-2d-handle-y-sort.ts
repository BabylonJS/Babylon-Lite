/** Optional stable-handle companion for Sprite2D Y-sort bias. */
import type { Sprite2DHandle } from "./sprite-2d-handle.js";
import { getSprite2DHandleIndex } from "./sprite-2d-handle.js";
import { setSprite2DYSortBias } from "./sprite-2d-y-sort.js";

/**
 * Set the Y-sort bias for the sprite referenced by a stable handle.
 * @param handle - Live Sprite2D handle whose current logical slot is resolved automatically.
 * @param bias - Finite value added to the sprite's `positionPx.y` for ordering only.
 */
export function setSprite2DYSortHandleBias(handle: Sprite2DHandle, bias: number): void {
    setSprite2DYSortBias(handle.layer, getSprite2DHandleIndex(handle), bias);
}
