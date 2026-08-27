/**
 * Antigravity Racer — Babylon Lite demo.
 *
 * A native port of Cédric Guillemet's "Antigravity racing game" Babylon.js
 * playground (snippet WVPVWL#0): fly a hover-ship around a closed, banked loop
 * track threaded through 7 editable control points, racing AI opponents,
 * boosting off energy strips, in single-player, 2-player split-screen,
 * attract/demo, or track-editor modes.
 *
 * What is ported verbatim: the 7 control points, the arc-length spline sampling,
 * the 256-segment procedural track piece, the per-segment frame data and the
 * deformation vertex shader that bends that straight piece onto the spline, the
 * exact rock transforms, the road artwork and compositing of the playground's
 * node material (snippet 01HFES#76 — track textures by Patrick Ryan, committed
 * here with his permission), and the two CC BY 4.0 Sketchfab models the
 * playground loads (ship "RHS-X" by Hassan Bassassi, rock "Obj_Nat_Rock_01" by
 * SaschaHenrichs) — vendored locally by `scripts/fetch-antigravity-racer.ts`.
 *
 * What is original: the engine trails, the procedural terrain, the DOM
 * menus/HUD, and the frame-rate-independent fixed-step simulation.
 *
 * Split into focused modules (see `antigravity-racer/`): track spline math +
 * deformation material, ship simulation, instanced ship/rock models, CPU ribbon
 * trails, camera rigs, keyboard+gamepad input, DOM menu/HUD, and the track
 * editor — see `game.ts` for how they're wired together.
 *
 * Controls: W/A/S/D (or ZQSD) + arrows to drive, C / shoulder buttons to
 * cycle camera, Esc / Start to pause. Gamepad supported throughout, including
 * menu navigation.
 */

import { runAntigravityRacer } from "./antigravity-racer/game.js";
import { installFetchProgress } from "./loading-progress.js";

/** ~12.8 MB of ship/rock model data + ~2.1 MB of road artwork. */
const ESTIMATED_ASSET_BYTES = 14_900_000;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: ESTIMATED_ASSET_BYTES });
    try {
        await runAntigravityRacer(canvas);
    } finally {
        progress.done();
    }
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
