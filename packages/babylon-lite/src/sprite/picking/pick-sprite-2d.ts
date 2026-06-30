/**
 * `pickSprite2D` — CPU hit-test for `Sprite2DLayer` sprites.
 *
 * A 2D sprite is a screen-space rectangle, so picking is closed-form: no GPU pass, no readback.
 * This module is imported only when an app actually calls `pickSprite2D`, so HUD / pure-2D
 * scenes that never pick pay zero bytes for it (it sits in its own `sprite/picking/` folder for
 * exactly that reason). The hit test inverts the same per-sprite transform the vertex shader
 * applies (pivot + rotation), so it reports the sprite the GPU actually drew under the point.
 */
import type { Sprite2DLayer } from "../sprite-2d.js";

/** Result of a successful {@link pickSprite2D} hit. */
export interface SpritePickInfo {
    /** The layer that owns the hit sprite. */
    layer: Sprite2DLayer;
    /** Index-API slot of the hit sprite within `layer` (the value returned by `addSprite2DIndex`). */
    spriteIndex: number;
    /**
     * Sprite-local hit coordinate in `[0, 1]`: `(0, 0)` is the quad's first corner and `(1, 1)`
     * the opposite one, corrected for the layer's pivot and the sprite's rotation. It equals the
     * within-quad UV fraction at the hit point, so a caller can map it to a frame-relative texel.
     */
    u: number;
    v: number;
}

// Per-instance float slots (mirror sprite-2d.ts / sprite-pipeline.ts):
//   [0..1] positionPx   [2..3] sizePx   [8] rotation
const POS_X = 0;
const POS_Y = 1;
const SIZE_X = 2;
const SIZE_Y = 3;
const ROTATION = 8;

/**
 * Hit-test a point against the sprites of one or more `Sprite2DLayer`s and return the topmost
 * sprite under it, or `null` for a miss.
 *
 * `xPx` / `yPx` are in the layers' **local** coordinate space — the same space as each sprite's
 * `positionPx`. For a layer rendered 1:1 to the canvas (identity `view`) that is simply the
 * backing-store pixel under the pointer (`(clientX - rect.left) * devicePixelRatio`). For a
 * panned / zoomed / rotated layer, map the pointer into layer space first via the inverse of
 * `layer.view` (the caller owns that transform). All `layers` are assumed to share one space.
 *
 * Layers are tested in reverse array order (later layers are drawn on top, so they win), and
 * within a layer the most-recently-added sprite wins — matching GPU draw order, so the returned
 * sprite is the one visually on top at that point. Layers with `visible: false` and hidden
 * sprites (`visible: false`, stored as a zero-size quad) are skipped, exactly as the renderer
 * skips them.
 *
 * @param layers - Sprite layers to test, in draw order (e.g. `spriteRenderer.layers`).
 * @param xPx - Query X in layer-local pixels.
 * @param yPx - Query Y in layer-local pixels.
 * @returns The topmost hit, or `null` if the point is over no sprite.
 */
export function pickSprite2D(layers: ReadonlyArray<Sprite2DLayer>, xPx: number, yPx: number): SpritePickInfo | null {
    for (let li = layers.length - 1; li >= 0; li--) {
        const layer = layers[li]!;
        if (!layer.visible) {
            continue;
        }
        const data = layer._instanceData;
        const stride = layer._instanceFloatsPerSprite;
        const pivotX = layer.pivot[0];
        const pivotY = layer.pivot[1];
        for (let i = layer.count - 1; i >= 0; i--) {
            const base = i * stride;
            const sizeX = data[base + SIZE_X]!;
            const sizeY = data[base + SIZE_Y]!;
            // A hidden sprite is stored as a degenerate (zero-size) quad; the renderer culls it,
            // so the picker must too. This also guards the divides below against a zero size.
            if (sizeX <= 0 || sizeY <= 0) {
                continue;
            }
            const dx = xPx - data[base + POS_X]!;
            const dy = yPx - data[base + POS_Y]!;
            // Invert the vertex shader's `rotate(localOffset, rotation)` by rotating the delta by
            // -rotation, then undo `(corner - pivot) * size` to recover the [0, 1] corner fraction.
            const rotation = data[base + ROTATION]!;
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);
            const localX = dx * cos + dy * sin;
            const localY = -dx * sin + dy * cos;
            const u = localX / sizeX + pivotX;
            const v = localY / sizeY + pivotY;
            if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                return { layer, spriteIndex: i, u, v };
            }
        }
    }
    return null;
}
