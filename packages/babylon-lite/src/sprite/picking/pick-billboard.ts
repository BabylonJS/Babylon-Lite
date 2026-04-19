/**
 * Billboard sprite picker — GPU 1×1 ID-pass via the engine's shared picker.
 *
 * Uses the same infrastructure as mesh picking (`createGpuPicker` /
 * `pickAsync`), so the picked silhouette matches the rendered silhouette
 * exactly — including alpha-cutout `discard` and per-sprite `pickable: false`.
 *
 * Per-system contributors are registered idempotently by the billboard
 * renderable when each system is added to the scene; this picker just
 * dispatches the existing async pick path and returns the sprite payload
 * smuggled onto the engine's `PickingInfo` by `billboard-pick-contributor.resolve()`.
 *
 * Apps that never pick a sprite pay zero bytes — this file is dynamic-imported
 * by `pickBillboardSprite` only, and the contributor is dynamic-imported by
 * the renderable only when a billboard system actually exists in the scene.
 */

import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { GpuPicker } from "../../picking/gpu-picker.js";
import { createGpuPicker, pickAsync } from "../../picking/gpu-picker.js";
import type { SpritePickInfo } from "./billboard-pick-contributor.js";
import { _setLastPickCoords } from "./billboard-pick-contributor.js";

export type { SpritePickInfo } from "./billboard-pick-contributor.js";

/** Lazy per-scene picker reuse — the same picker is shared across mesh + sprite picks. */
function getOrCreatePickerForScene(scene: SceneContext): GpuPicker {
    const ctx = scene as SceneContextInternal & { _gpuPicker?: GpuPicker };
    if (!ctx._gpuPicker) {
        ctx._gpuPicker = createGpuPicker(scene);
    }
    return ctx._gpuPicker;
}

/** Pick the topmost billboard sprite under the given canvas pixel.
 *  Returns null when no sprite covers the cursor or the scene has no camera. */
export async function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number): Promise<SpritePickInfo | null> {
    if (!scene.camera) {
        return null;
    }
    _setLastPickCoords(xPx, yPx);
    const picker = getOrCreatePickerForScene(scene);
    const info = await pickAsync(picker, xPx, yPx);
    if (!info.hit) {
        return null;
    }
    const sprite = (info as unknown as { _spritePick?: SpritePickInfo })._spritePick;
    return sprite ?? null;
}
