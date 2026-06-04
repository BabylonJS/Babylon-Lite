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
import { demoAssetUrl } from "./demo-asset-url.js";

// Studio HDR env (same as mosquito-amber) — bright key + soft fill from every
// angle, gives the glossy enamel cubes something specular to reflect.
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

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

    // HDR IBL — drives reflections + ambient on all PBR materials. We don't
    // want the env as a visible skybox (it would compete with the dark backdrop
    // designed to make the colored blocks pop), so skip both skybox + ground.
    await loadEnvironment(scene, ENV_URL, {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
    });

    // ACES-style tone mapping so the bright emissive particle chips don't
    // clip to pure white. Slightly dialled-down exposure keeps the dark
    // backdrop punchy.
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.exposure = 0.95;
    scene.imageProcessing.contrast = 1.15;

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
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && !game.over && !game.paused) {
            togglePause(game);
        }
    });

    onBeforeRender(scene, (deltaMs: number) => {
        const now = performance.now();
        if (left.keyDown && now >= left.next) {
            moveLeft(game);
            left.next = now + DAS_REPEAT;
        }
        if (right.keyDown && now >= right.next) {
            moveRight(game);
            right.next = now + DAS_REPEAT;
        }
        if (down.keyDown && now >= down.next) {
            softDrop(game);
            down.next = now + SOFT_DROP_REPEAT;
        }

        tickGame(game, deltaMs);
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
