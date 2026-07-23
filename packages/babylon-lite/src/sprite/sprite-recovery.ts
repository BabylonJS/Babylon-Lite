import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { SpriteRenderer } from "./sprite-renderer.js";
import { _getSpriteFxHook } from "./sprite-fx-hook.js";
import { LAYER_UBO_BYTES, SHARED_SPRITE_INDEX_DATA, createSpriteInstanceBuffer, getOrCreateSpritePipeline } from "./sprite-pipeline.js";

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
        rebuildSpriteRendererGpu(renderer);
    }
}

function rebuildSpriteRendererGpu(renderer: SpriteRenderer): void {
    const engine = renderer._surface.engine;
    const fxHook = _getSpriteFxHook();
    renderer._indexBuffer = createMappedBuffer(engine, SHARED_SPRITE_INDEX_DATA, BU.INDEX);
    renderer._targetView = renderer._target?.view ?? null;
    renderer._visibleBundles.length = 0;

    for (const lg of renderer._layerGpu.values()) {
        lg.instanceBuffer = createSpriteInstanceBuffer(engine._device, lg.layer);
        lg.instanceBufferCapacity = lg.layer._capacity;
        lg.uniformBuffer = createEmptyUniformBuffer(engine, LAYER_UBO_BYTES);
        lg.bindGroup = null;
        lg.uploadedVersion = -1;
        if (lg.fx) {
            fxHook!.disposeFx(lg.fx);
            lg.fx = fxHook!.createLayerFx(engine, "sprite-layer-fx-ubo", lg.layer);
        }
        lg.pipeline = null;
        lg.lastUbo.fill(0);
        lg.uboUploaded = false;
        lg.renderBundle = null;
        lg.bundleCount = -1;
    }
    for (const layer of renderer.layers) {
        getOrCreateSpritePipeline(engine, renderer._pipelineCache, renderer._surface.format, 1, layer.blendMode, false, false, undefined, undefined, layer);
    }
}
