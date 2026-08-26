// MEASUREMENT-ONLY entry for the SPRITES player (raster atlas), for the unified sprite-vs-stencil
// size comparison. Imports the sprites player's MAIN-THREAD renderer core (createAnimationController
// Async) from the VENDORED sprite source (measure/vendor/sprite — see vendor/README.md), matching the
// kind of entry the stencil player exposes (createLottiePlayer + renderLottieFrame) so the comparison
// is renderer-to-renderer (no worker infra on either side). The sprites player's feature modules
// (solid/shape/text/gradient) are dynamic-imported by its registry, so a code-split build emits them
// as separate chunks — the same per-feature gating the stencil split measures.
//
// This file is not shipped and not part of the package.
import { createAnimationControllerAsync, playAnimation } from "./vendor/sprite/rendering/animationController.js";
import type { RawLottieAnimation } from "./vendor/sprite/parsing/rawTypes.js";

export async function run(canvas: HTMLCanvasElement, json: RawLottieAnimation): Promise<void> {
    const controller = await createAnimationControllerAsync(canvas, json, 1, 1, new Map<string, string>(), { loopAnimation: true });
    playAnimation(controller);
}

// Prevent the bundler from tree-shaking the entry away.
(globalThis as unknown as { __run?: unknown }).__run = run;
