// MEASUREMENT-ONLY entry for the CURRENT PRODUCTION Babylon.js Lottie player
// (`@babylonjs/lottie-player`), for the unified size/perf comparison against the new lite `stencil`
// (vector) and `sprite` (raster) players. This is the player customers ship TODAY: a sprite-atlas
// renderer running on a Babylon `ThinEngine` — i.e. a slice of `@babylonjs/core`.
//
// We measure `LocalPlayer` (main-thread) so the flat bundle is directly comparable to the lite
// players' local builds. The production `Player` (OffscreenCanvas + worker) path splits the SAME
// rendering code across a small main-thread client + a worker chunk, but ships equivalent TOTAL
// bytes — `LocalPlayer` puts all of it on one axis for an apples-to-apples "everything loaded" size.
//
// Unlike the included sprite benchmark source under measure/vendor/, this player is consumed from
// its published npm package at a pinned version (@babylonjs/lottie-player + @babylonjs/core, both
// 9.8.0).
//
// This file is not shipped and not part of the package.
import { LocalPlayer } from "@babylonjs/lottie-player";
import type { RawLottieAnimation } from "@babylonjs/lottie-player";

export async function run(container: HTMLElement, json: RawLottieAnimation): Promise<void> {
    const player = new LocalPlayer();
    await player.playAnimationAsync({ container, animationSource: json, variables: null, configuration: { loopAnimation: true } });
}

// Prevent the bundler from tree-shaking the entry away.
(globalThis as unknown as { __run?: unknown }).__run = run;
