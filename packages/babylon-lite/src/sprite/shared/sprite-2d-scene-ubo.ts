/**
 * Sprite2DSceneUBO — shared per-Scene2DContext UBO for Sprite2DLayer renderables.
 *
 * Layout (32 B):
 *   offset  0..7   viewportPx:    vec2<f32>
 *   offset  8..15  invViewportPx: vec2<f32>
 *   offset 16..23  viewPositionPx: vec2<f32>
 *   offset 24..27  zoom:          f32
 *   offset 28..31  viewRotation:  f32
 *
 * Per-scene registration: the first Sprite2DLayer renderable that needs this UBO calls
 * `ensureSprite2DSceneUBO(scene)`. The scene stashes the buffer in `_sprite2dSceneUBO`
 * and pushes a single updater onto `_updaters`. Subsequent layers reuse the same buffer.
 *
 * Zero module-level side effects (per GUIDANCE rule 4).
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { Scene2DContext, Scene2DContextInternal } from "../../scene2d/scene2d.js";

/** Total bytes of the Sprite2DSceneUBO layout above. */
export const SPRITE_2D_SCENE_UBO_BYTES = 32;

/**
 * Lazily create the per-Scene2DContext Sprite2DSceneUBO and register its updater.
 * Returns the GPU buffer (cached on the scene). Idempotent — subsequent calls
 * return the same buffer without registering another updater.
 */
export function ensureSprite2DSceneUBO(scene: Scene2DContext): GPUBuffer {
    const ctx = scene as Scene2DContextInternal;
    if (ctx._sprite2dSceneUBO) {
        return ctx._sprite2dSceneUBO;
    }
    const engine = ctx.engine as EngineContextInternal;
    const buf = engine.device.createBuffer({
        label: "sprite2d-scene-ubo",
        size: SPRITE_2D_SCENE_UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    ctx._sprite2dSceneUBO = buf;
    ctx._disposables.push(() => buf.destroy());

    const scratch = new Float32Array(SPRITE_2D_SCENE_UBO_BYTES / 4);
    ctx._updaters.push({
        update(): void {
            const w = engine.canvas.width;
            const h = engine.canvas.height;
            scratch[0] = w;
            scratch[1] = h;
            scratch[2] = w > 0 ? 1 / w : 0;
            scratch[3] = h > 0 ? 1 / h : 0;
            // View defaults to identity for the shared UBO. Per-layer pan/zoom/rotation
            // is reserved for a future per-layer UBO if/when the feature is needed.
            scratch[4] = 0;
            scratch[5] = 0;
            scratch[6] = 1;
            scratch[7] = 0;
            engine.device.queue.writeBuffer(buf, 0, scratch.buffer, scratch.byteOffset, SPRITE_2D_SCENE_UBO_BYTES);
        },
    });

    return buf;
}
