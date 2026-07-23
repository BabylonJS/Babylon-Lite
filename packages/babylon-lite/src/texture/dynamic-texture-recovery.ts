/**
 * Device-lost rebuild for `createDynamicTexture` textures.
 *
 * This is its own module, dynamically imported by `device-lost-recovery` only
 * when a dynamic texture actually needs rebuilding after device loss. That
 * lazy-import boundary is deliberate and cuts both ways:
 *
 * - `dynamic-texture.ts` (the create/update API) never references it, so a scene
 *   that uses dynamic textures but not device-lost recovery bundles none of this.
 * - `device-lost-recovery.ts` (the always-bundled recovery orchestrator) only
 *   `await import()`s it, so a scene that enables recovery but never creates a
 *   dynamic texture bundles none of this either — it lands in a separate,
 *   on-demand chunk fetched only if a dynamic-texture rebuild ever fires.
 *
 * The recovery record on the texture carries the immutable creation params plus
 * the live source retained by the last `updateDynamicTexture`; this module reads
 * both from it, mirroring how the url/solid/bitmap kinds are rebuilt.
 */

import { TU } from "../engine/gpu-flags.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import { generateMipmaps } from "./generate-mipmaps.js";
import type { Texture2D } from "./texture-2d.js";
import type { EngineContext } from "../engine/engine.js";

/**
 * Re-allocate a `createDynamicTexture` texture after device loss, restoring the
 * same format/usage/sampler and — if a live source (e.g. a persistent canvas)
 * was retained by the last `updateDynamicTexture` — re-blitting it so content
 * survives too. With no retained source the texture comes back transparent
 * black, exactly as a freshly created dynamic texture reads before its first
 * update. All parameters are read from the texture's retained recovery record.
 */
export async function rebuildDynamicTexture2D(engine: EngineContext, tex: Texture2D): Promise<void> {
    const rec = tex._recoverySource;
    if (!rec || rec.kind !== "dynamic") {
        return;
    }
    const { width, height, format, levels, samplerDesc } = rec;
    const rebuilt = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount: levels,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });
    if (rec.source) {
        // The retained source is the caller's own external-image object. Canvas-like
        // sources (`HTMLCanvasElement`/`OffscreenCanvas`) persist, but an `ImageBitmap`
        // or `VideoFrame` may have been `.close()`d after the last update — re-blitting a
        // closed/detached source throws synchronously (`InvalidStateError`). Isolate that
        // here so one dead source degrades this single texture to blank (its documented
        // "before first update" state) instead of aborting the entire device recovery,
        // and drop the reference so a later loss neither retries it nor pins a detached
        // resource.
        try {
            engine._device.queue.copyExternalImageToTexture({ source: rec.source, flipY: rec.flipY }, { texture: rebuilt, premultipliedAlpha: rec.premultipliedAlpha }, [
                width,
                height,
            ]);
            if (levels > 1) {
                generateMipmaps(engine, rebuilt);
            }
        } catch {
            rec.source = null;
        }
    }
    tex.texture = rebuilt;
    tex.view = rebuilt.createView();
    tex.sampler = getOrCreateSampler(engine, samplerDesc);
    tex.width = width;
    tex.height = height;
    // Restore the creation-time ownership reference createDynamicTexture took on the
    // original GPUTexture (its `acquireTexture(tex)`). Swapping in a fresh GPUTexture
    // starts it at ref-count 0, so without this the rebuilt texture would carry only the
    // material bindings' refs and be destroyed the instant the last material releases it —
    // even though the caller still holds the DynamicTexture2D. Re-acquiring keeps it alive
    // for the caller's own lifetime, exactly as at creation.
    acquireTexture(tex);
}
