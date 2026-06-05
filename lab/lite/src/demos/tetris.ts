/**
 * Demo — 3D Tetris.
 *
 * Classic Tetris rules played on a 10×20 well, rendered with Babylon Lite's
 * thin-instanced PBR cubes, HDR image-based lighting, MSAA-anti-aliased
 * direct rendering and shader-material particle bursts on line clears.
 *
 * Game logic, DOM HUD, particles and 3D rendering are split into
 * ./tetris/{game,renderer,hud,particles}.ts; this file is the wiring + input
 * layer + scene/IBL setup.
 */

import {
    createEngine,
    createSceneContext,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";

import { createGame, hardDrop, moveLeft, moveRight, restartGame, rotateCCW, rotateCW, softDrop, tickGame, togglePause } from "./tetris/game.js";
import { createTetrisRenderer } from "./tetris/renderer.js";
import { createTetrisHud } from "./tetris/hud.js";
import { createTetrisAudio } from "./tetris/sound.js";

// A studio HDR environment drives the IBL — reflections + ambient on every PBR
// material. The visible background is a *blurred* PBR skybox box that samples
// this same environment along the view ray (see renderer.ts), giving a soft
// photographic backdrop with real lighting variation rather than a flat colour.
// Stored locally under lab/public so it loads same-origin.
const ENV_URL = "/textures/environment.env";
const BRDF_URL = "/brdf-lut.png";

// Repeat rates for held arrow keys (ms).
const DAS_DELAY = 170;
const DAS_REPEAT = 55;
const SOFT_DROP_REPEAT = 45;

interface RepeatState {
    keyDown: boolean;
    next: number;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    // 2× supersample for crisp edges. The engine sizes its swapchain to
    // `clientWidth * devicePixelRatio`, so doubling the reported DPR causes
    // the scene to render at 4× the pixel count and the browser does the
    // final bilinear downsample to the display — combined with the default
    // 4× MSAA on the render task this gives effectively ~16× anti-aliasing
    // on the high-contrast block silhouettes + neon rails.
    const baseDpr = globalThis.devicePixelRatio || 1;
    try {
        Object.defineProperty(globalThis, "devicePixelRatio", {
            configurable: true,
            get: () => baseDpr * 2,
        });
    } catch {
        // Some browsers refuse to override DPR — accept the fallback.
    }

    const engine = await createEngine(canvas);

    // Use the default render task — it sets up a 4× MSAA swapchain target so
    // the high-contrast block edges read as crisp lines rather than the
    // jagged staircase we'd get from a sampleCount=1 source target.
    const scene = createSceneContext(engine);

    // Environment drives the IBL (reflections + ambient on all PBR materials)
    // only — the visible background is a blurred PBR skybox box built in the
    // renderer, so we skip the built-in skybox here. skipGround keeps the
    // environment's ground plane out — the playfield has its own floor slab.
    await loadEnvironment(scene, ENV_URL, {
        brdfUrl: BRDF_URL,
        skipSkybox: true,
        skipGround: true,
    });

    // loadEnvironment enables ACES tone mapping by default (exposure 0.8,
    // contrast 1.2). Keep those — they read cleanly against the studio backdrop
    // without crushing the glossy block highlights.

    const game = createGame();
    const renderer = await createTetrisRenderer(engine, scene);
    const hud = createTetrisHud(document.body);
    const audio = createTetrisAudio();

    hud.onRestart(() => {
        audio.resume();
        restartGame(game);
    });

    function toggleMode(): void {
        hud.setMode(renderer.toggleMode());
    }
    hud.onToggleMode(toggleMode);

    function toggleMute(): void {
        audio.resume();
        hud.setMuted(audio.toggleMuted());
    }
    hud.onToggleMute(toggleMute);
    hud.setMuted(audio.muted);
    hud.setMode(renderer.mode);

    const left: RepeatState = { keyDown: false, next: 0 };
    const right: RepeatState = { keyDown: false, next: 0 };
    const down: RepeatState = { keyDown: false, next: 0 };

    function keyHandler(e: KeyboardEvent): void {
        // First key press is a user gesture — safe to (re)start the AudioContext.
        audio.resume();
        if (e.repeat) {
            e.preventDefault();
            return;
        }
        switch (e.code) {
            case "ArrowLeft":
                left.keyDown = true;
                left.next = performance.now() + DAS_DELAY;
                if (moveLeft(game)) {
                    audio.play("move");
                }
                e.preventDefault();
                break;
            case "ArrowRight":
                right.keyDown = true;
                right.next = performance.now() + DAS_DELAY;
                if (moveRight(game)) {
                    audio.play("move");
                }
                e.preventDefault();
                break;
            case "ArrowDown":
                down.keyDown = true;
                down.next = performance.now() + SOFT_DROP_REPEAT;
                if (softDrop(game)) {
                    audio.play("softDrop");
                }
                e.preventDefault();
                break;
            case "ArrowUp":
            case "KeyX":
                if (rotateCW(game)) {
                    audio.play("rotate");
                }
                e.preventDefault();
                break;
            case "KeyZ":
                if (rotateCCW(game)) {
                    audio.play("rotate");
                }
                e.preventDefault();
                break;
            case "Space": {
                const hadPiece = game.active !== null;
                hardDrop(game);
                if (hadPiece && !game.paused) {
                    audio.play("hardDrop");
                }
                e.preventDefault();
                break;
            }
            case "KeyP":
                togglePause(game);
                audio.play("pause");
                e.preventDefault();
                break;
            case "KeyR":
                restartGame(game);
                e.preventDefault();
                break;
            case "KeyM":
                toggleMode();
                e.preventDefault();
                break;
            case "KeyS":
                toggleMute();
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
    window.addEventListener("pointerdown", () => audio.resume());
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && !game.over && !game.paused) {
            togglePause(game);
        }
    });

    onBeforeRender(scene, (deltaMs: number) => {
        const now = performance.now();
        if (left.keyDown && now >= left.next) {
            if (moveLeft(game)) {
                audio.play("move");
            }
            left.next = now + DAS_REPEAT;
        }
        if (right.keyDown && now >= right.next) {
            if (moveRight(game)) {
                audio.play("move");
            }
            right.next = now + DAS_REPEAT;
        }
        if (down.keyDown && now >= down.next) {
            if (softDrop(game)) {
                audio.play("softDrop");
            }
            down.next = now + SOFT_DROP_REPEAT;
        }

        tickGame(game, deltaMs);

        // Drain rules-layer outcome sounds (lock / clear / level-up / game-over).
        if (game.pendingSounds.length > 0) {
            for (const sound of game.pendingSounds) {
                audio.play(sound);
            }
            game.pendingSounds.length = 0;
        }

        renderer.sync(game, deltaMs);
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
