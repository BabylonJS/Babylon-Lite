// Image renderer — decodes each asset (possibly a data: URI) into a GL texture and draws every
// image layer (ty 2) as a textured quad. A thin adapter over the shared textured-quad renderer: it
// owns the per-asset textures and their async decode; all GL plumbing lives in textured-quad.ts.

import { type GLEngineContext, type GLTexture, disposeTexture, loadTexture2D } from "@babylonjs/lite-gl";
import type { LayerRenderer } from "./layer-renderer.js";
import type { ParsedAsset, ParsedLayer } from "../animation/parse.js";
import { createTexturedQuadRenderer, type QuadRect } from "./textured-quad.js";

/** Create the image-layer renderer. Kicks off async decode of every asset's image; layers paint
 *  (transparent) until their texture is ready, and readiness waits for all of them. */
export function createImageRenderer(engine: GLEngineContext, assets: readonly ParsedAsset[], onError?: () => void): LayerRenderer {
    // One texture per asset (indexed by assetIndex). Empty `src` → null (layer paints nothing).
    const textures: (GLTexture | null)[] = assets.map((a) => (a.src ? loadTexture2D(engine, a.src, undefined, undefined, onError) : null));

    return createTexturedQuadRenderer(engine, {
        kind: 2,
        // Ready once every asset texture has finished decoding, so the first painted frame shows
        // images rather than transparent placeholders.
        ready: () => textures.every((t) => t === null || t.isReady),
        fillRect(layer: ParsedLayer, rect: QuadRect): boolean {
            const img = layer.image;
            if (!img || !textures[img.assetIndex]) {
                return false;
            }
            // Local image rect (0,0)-(w,h); the shared renderer maps it to screen.
            rect.left = 0;
            rect.top = 0;
            rect.width = img.width;
            rect.height = img.height;
            return true;
        },
        textureFor: (layer) => (layer.image ? textures[layer.image.assetIndex] : null),
        disposeTextures() {
            for (const t of textures) {
                if (t) {
                    disposeTexture(engine, t);
                }
            }
        },
    });
}
