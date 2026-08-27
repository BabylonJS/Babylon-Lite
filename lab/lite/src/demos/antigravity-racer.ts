/**
 * Antigravity Racer — Babylon Lite demo.
 *
 * A from-scratch native port of Cédric Guillemet's "Antigravity racing game"
 * Babylon.js playground (snippet WVPVWL#0): fly a hover-ship around a closed,
 * banked loop track threaded through 7 editable control points, racing AI
 * opponents, boosting off energy strips, in single-player, 2-player
 * split-screen, attract/demo, or track-editor modes.
 *
 * Split into focused modules (see `antigravity-racer/`): track spline math +
 * mesh, ship simulation, procedural ship/rock visuals, CPU ribbon trails,
 * camera rigs, keyboard+gamepad input, DOM menu/HUD, and the track editor —
 * see `game.ts` for how they're wired together and GUIDANCE for the
 * CPU-geometry / no-remote-assets / frame-rate-independent design choices.
 *
 * Controls: W/A/S/D (or ZQSD) + arrows to drive, C / shoulder buttons to
 * cycle camera, Esc / Start to pause. Gamepad supported throughout, including
 * menu navigation.
 */

import { runAntigravityRacer } from "./antigravity-racer/game.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await runAntigravityRacer(canvas);
}

main().catch((err: unknown) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && (err as Error).stack ? (err as Error).stack : ""}`;
    document.body.appendChild(pre);
});
