/**
 * Demo — 3D Tetris.
 *
 * Classic Tetris rules played on a 10×20 well, rendered with Babylon Lite's
 * thin-instanced cubes for a low-draw-call 3D playfield (7 colored meshes +
 * 1 ghost piece + a few static frame parts). Game logic, DOM HUD and 3D
 * rendering are split into ./tetris/{game,renderer,hud}.ts; this file is the
 * wiring + input layer.
 */

import { createEngine, createSceneContext, onBeforeRender, registerScene, startEngine } from "babylon-lite";

import { createGame, hardDrop, moveLeft, moveRight, restartGame, rotateCCW, rotateCW, softDrop, tickGame, togglePause } from "./tetris/game.js";
import { createTetrisRenderer } from "./tetris/renderer.js";
import { createTetrisHud } from "./tetris/hud.js";

// Repeat rates for held arrow keys (ms).
const DAS_DELAY = 170; // delayed auto-shift before repeats kick in
const DAS_REPEAT = 55; // repeat interval after delay
const SOFT_DROP_REPEAT = 45;

interface RepeatState {
    keyDown: boolean;
    next: number; // performance.now() ms at which the next repeat fires
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const game = createGame();
    const renderer = createTetrisRenderer(engine, scene);
    const hud = createTetrisHud(document.body);

    hud.onRestart(() => {
        restartGame(game);
    });

    const left: RepeatState = { keyDown: false, next: 0 };
    const right: RepeatState = { keyDown: false, next: 0 };
    const down: RepeatState = { keyDown: false, next: 0 };

    function keyHandler(e: KeyboardEvent): void {
        if (e.repeat) {
            // We do our own repeat handling so behaviour stays consistent across
            // browser key-repeat settings.
            e.preventDefault();
            return;
        }
        switch (e.code) {
            case "ArrowLeft":
                left.keyDown = true;
                left.next = performance.now() + DAS_DELAY;
                moveLeft(game);
                e.preventDefault();
                break;
            case "ArrowRight":
                right.keyDown = true;
                right.next = performance.now() + DAS_DELAY;
                moveRight(game);
                e.preventDefault();
                break;
            case "ArrowDown":
                down.keyDown = true;
                down.next = performance.now() + SOFT_DROP_REPEAT;
                softDrop(game);
                e.preventDefault();
                break;
            case "ArrowUp":
            case "KeyX":
                rotateCW(game);
                e.preventDefault();
                break;
            case "KeyZ":
                rotateCCW(game);
                e.preventDefault();
                break;
            case "Space":
                hardDrop(game);
                e.preventDefault();
                break;
            case "KeyP":
                togglePause(game);
                e.preventDefault();
                break;
            case "KeyR":
                restartGame(game);
                e.preventDefault();
                break;
        }
    }

    function keyUpHandler(e: KeyboardEvent): void {
        switch (e.code) {
            case "ArrowLeft":
                left.keyDown = false;
                break;
            case "ArrowRight":
                right.keyDown = false;
                break;
            case "ArrowDown":
                down.keyDown = false;
                break;
        }
    }

    window.addEventListener("keydown", keyHandler);
    window.addEventListener("keyup", keyUpHandler);
    // Pause when the tab is hidden so the player doesn't return to a topped-out well.
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && !game.over && !game.paused) {
            togglePause(game);
        }
    });

    onBeforeRender(scene, (deltaMs: number) => {
        const now = performance.now();
        if (left.keyDown && now >= left.next) {
            if (moveLeft(game)) {
                left.next = now + DAS_REPEAT;
            } else {
                left.next = now + DAS_REPEAT;
            }
        }
        if (right.keyDown && now >= right.next) {
            if (moveRight(game)) {
                right.next = now + DAS_REPEAT;
            } else {
                right.next = now + DAS_REPEAT;
            }
        }
        if (down.keyDown && now >= down.next) {
            softDrop(game);
            down.next = now + SOFT_DROP_REPEAT;
        }

        tickGame(game, deltaMs);
        renderer.sync(game);
        hud.render(game);
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && err.stack ? err.stack : ""}`;
    document.body.appendChild(pre);
});
