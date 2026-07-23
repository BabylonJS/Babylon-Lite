import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { SpriteRenderer } from "./sprite-renderer.js";
import { _rebuildSpriteRendererGpu } from "./sprite-renderer.js";

/**
 * Rebuild every registered SpriteRenderer on the replacement device.
 * This module is reached only through the Sprite recovery adapter's lazy import.
 */
export async function rebuildRegisteredSpriteRenderers(engine: EngineContext): Promise<void> {
    const renderers: SpriteRenderer[] = [];
    const textures = new Set<Texture2D>();

    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (context._kind !== "sprite-renderer") {
                continue;
            }
            const renderer = context as SpriteRenderer;
            renderers.push(renderer);
            if (renderer._target) {
                textures.add(renderer._target);
            }
            for (const layer of renderer.layers) {
                textures.add(layer.atlas.texture);
                for (const extra of layer.customShader?._extraTextures ?? []) {
                    textures.add(extra.texture);
                }
            }
        }
    }

    if (textures.size > 0) {
        const { rebuildTexture2D } = await import("../texture/texture-recovery.js");
        await Promise.all(Array.from(textures, (texture) => rebuildTexture2D(engine, texture)));
    }
    for (const renderer of renderers) {
        _rebuildSpriteRendererGpu(renderer);
    }
}
