// Full player: parses a Lottie document, builds the renderers its layers need (fill for
// shapes/solids, text for ty:5, image for ty:2), and assembles a LottiePlayer via the shared core.
// The full worker imports this factory to render any supported Lottie animation.
//
// The shapes worker imports `createShapePlayer` instead; its module graph never reaches the text or
// image renderers, so they (and the babylon-lite-gl texture path) tree-shake away.

import type { GLEngineContext } from "@babylonjs/lite-gl";
import type { LottieFile } from "../animation/lottie-raw.js";
import type { LayerRenderer } from "../rendering/layer-renderer.js";
import { parseAnimation, type LottiePlayerOptions } from "../animation/parse.js";
import { createFillRenderer } from "../rendering/fill-renderer.js";
import { createTextRenderer } from "../rendering/text-renderer.js";
import { createImageRenderer } from "../rendering/image-renderer.js";
import { buildPlayer, type LottiePlayer } from "./player-core.js";

// Re-export the renderer-agnostic core for internal consumers and measurement tooling.
export { createVectorEngine, renderLottieFrame, isPlayerReady, disposePlayer } from "./player-core.js";
export type { LottiePlayer } from "./player-core.js";
export type { LottiePlayerOptions } from "../animation/parse.js";

/** Resolve external image paths for a document fetched from `sourceUrl`. @internal */
export function resolveImageAssetUrls(file: LottieFile, sourceUrl: string): void {
    for (const asset of file.assets ?? []) {
        if (asset.p) {
            asset.p = new URL((asset.u || "") + asset.p, sourceUrl).href;
            asset.u = "";
        }
    }
}

/** Create a player for a Lottie document. Builds only the renderers the animation needs (shape,
 *  text, image), detected from its layers. Pass `options.variables` to substitute text-layer content
 *  at load time for localization (whole-string key match). */
export function createLottiePlayer(engine: GLEngineContext, file: LottieFile, options?: LottiePlayerOptions, onError?: () => void): LottiePlayer {
    const anim = parseAnimation(file, options?.variables);
    const renderers = new Map<number, LayerRenderer>();

    // Shape + solid layers (both reported as kind 4 by the parser).
    if (anim.layers.some((layer) => layer.kind === 4 && layer.ops.length > 0)) {
        renderers.set(4, createFillRenderer(engine));
    }
    // Text layers (ty 5): rasterized glyphs drawn as textured quads.
    const textLayers = anim.layers.filter((layer) => layer.kind === 5 && !!layer.text?.text);
    if (textLayers.length) {
        renderers.set(5, createTextRenderer(engine, textLayers));
    }
    // Image layers (ty 2): decoded asset textures drawn as textured quads.
    if (anim.layers.some((layer) => layer.kind === 2 && layer.image !== undefined)) {
        renderers.set(2, createImageRenderer(engine, anim.assets, onError));
    }

    return buildPlayer(engine, anim, renderers);
}
