/**
 * Platformer demo (Super Mario Bros-style) — built on Babylon Lite's pure-2D
 * sprite path (no scene, camera, mesh, or light — just a `SpriteRenderer`).
 *
 * A full side-scrolling action level: run/jump physics with variable jump height,
 * coyote-time and input buffering; stompable slime enemies and kickable snail
 * shells; ?-blocks, breakable bricks, coins, a mushroom grow power-up and an
 * invincibility star; spike and pit hazards; lives, a countdown timer and score;
 * and a flagpole goal — all rendered through the engine's batched 2D sprite
 * renderer.
 *
 * Rendering goes entirely through the public Babylon Lite API. Capabilities the
 * engine does not provide (swept-AABB tile physics, keyboard/touch input, the DOM
 * HUD, and Web Audio SFX) are hand-rolled clean-room in the `platformer/` module
 * folder — explicitly allowed for the demos, which exist to showcase the renderer.
 *
 * Assets are a curated CC0 subset of Kenney's "Platformer Art Deluxe",
 * committed under `lab/public/platformer/` (CC0 — no attribution required, no
 * network fetch).
 */

import { createEngine } from "babylon-lite";
import { startGame } from "./platformer/game.js";
import { installFetchProgress } from "./loading-progress.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 1_000_000 });
    const engine = await createEngine(canvas);
    await startGame(canvas, engine);
    progress.done();
}

main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;white-space:pre-wrap;background:#1a1020;color:#ffb4b4;font:13px monospace;z-index:99999;";
    pre.textContent = "Platformer demo failed to start:\n\n" + (error instanceof Error ? (error.stack ?? error.message) : String(error));
    document.body.appendChild(pre);
});
