// Minimal shapes-only player — for splashscreens and other vector-only Lottie animations. It
// constructs ONLY the fill renderer (shapes, solids, gradients, strokes, masks, morphs) and never
// references the text or image renderers. Because the shapes worker's module graph cannot reach
// those renderers, it also excludes the babylon-lite-gl texture / sampler path they require.
//
// Contract: renders shape (ty 4) + solid (ty 1) layers. Text (ty 5) and image (ty 2) layers are
// ignored. The full worker uses createLottiePlayer for animations that may contain those layers.

import type { GLEngineContext } from "@babylonjs/lite-gl";
import type { LottieFile } from "../animation/lottie-raw.js";
import type { LayerRenderer } from "../rendering/layer-renderer.js";
import { parseAnimation, type LottiePlayerOptions } from "../animation/parse.js";
import { createFillRenderer } from "../rendering/fill-renderer.js";
import { buildPlayer, type LottiePlayer } from "./player-core.js";

/** Create a minimal, shapes-only player for a vector Lottie document (e.g. a splashscreen). Renders
 *  shape + solid layers only; text and image layers are ignored. Drive it with the same
 *  `renderLottieFrame` / `isPlayerReady` / `disposePlayer` as the full player. `options` matches
 *  `createLottiePlayer`; its `variables` are accepted for signature parity but have no effect
 *  here (shapes-only ignores text layers). */
export function createShapePlayer(engine: GLEngineContext, file: LottieFile, options?: LottiePlayerOptions): LottiePlayer {
    const anim = parseAnimation(file, options?.variables);
    const renderers = new Map<number, LayerRenderer>();
    // Shape + solid layers (both reported as kind 4 by the parser). Always built — a shapes-only
    // animation always has them, and skipping feature detection keeps the minimal entry minimal.
    renderers.set(4, createFillRenderer(engine));
    return buildPlayer(engine, anim, renderers);
}
