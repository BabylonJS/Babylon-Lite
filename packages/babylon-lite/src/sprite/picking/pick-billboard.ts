/**
 * `pickBillboardSprite` — GPU hit-test for `*BillboardSpriteSystem` sprites.
 *
 * Billboards live in the scene's 3D pass, interleaved with meshes by depth, so picking one
 * requires the same depth-sorted GPU pass the mesh picker uses (a billboard behind a wall must
 * not be picked through it). This is a thin wrapper over the shared {@link pickAsync} pass: the
 * picker draws meshes, Gaussian-splatting meshes, and every billboard system into one 1×1
 * depth-sorted target; when a billboard sprite is the closest hit it attaches a `_spritePick`
 * payload, which this function extracts.
 *
 * Imported only when an app calls `pickBillboardSprite`, so scenes that never pick a billboard
 * pay zero bytes for it (and a billboard-free scene never even fetches the GPU pick pipeline).
 */
import type { SceneContext } from "../../scene/scene-core.js";
import { createGpuPicker, pickAsync, disposePicker, type GpuPicker } from "../../picking/gpu-picker.js";
import type { BillboardPickInfo } from "../../picking/billboard-pick-pipeline.js";

export type { BillboardPickInfo } from "../../picking/billboard-pick-pipeline.js";

/**
 * Pick the topmost billboard sprite under a point, respecting occlusion by meshes and other
 * billboards (closest wins). Returns `null` if no billboard is the closest hit there — including
 * when a mesh is in front of the billboard, in which case the billboard is considered occluded.
 *
 * By default a throwaway {@link GpuPicker} is created and disposed per call, so a one-off pick
 * (e.g. click-to-select) retains no GPU state. For high-frequency picking (hover, drag) pass a
 * caller-owned `picker` from {@link createGpuPicker}: its 1×1 targets, scene UBO, and per-source
 * contributors (which compile the pick pipelines) are then reused across calls instead of rebuilt
 * each time, and the caller disposes it once via {@link disposePicker} when done. A supplied picker
 * must belong to `scene` — the same one passed to `createGpuPicker`.
 *
 * @param scene - Scene whose billboard systems (and meshes, for occlusion) are tested.
 * @param x - Query X in CSS pixels relative to the scene's canvas (same convention as `pickAsync`).
 * @param y - Query Y in CSS pixels relative to the scene's canvas.
 * @param picker - Optional caller-owned picker to reuse; when omitted, one is created and disposed per call.
 * @returns The billboard hit (`{ system, spriteIndex, pickedPoint, distance }`), or `null` for a miss.
 */
export async function pickBillboardSprite(scene: SceneContext, x: number, y: number, picker?: GpuPicker): Promise<BillboardPickInfo | null> {
    const owned = picker ?? createGpuPicker(scene);
    try {
        const info = await pickAsync(owned, x, y);
        return info._spritePick ?? null;
    } finally {
        // Only dispose a picker we created here; a caller-supplied picker is theirs to reuse and dispose.
        if (picker === undefined) {
            disposePicker(owned);
        }
    }
}
