// Renderer-agnostic playback controller — owns the WebGL2 engine, the animation clock, and the
// per-frame render loop for ONE animation, on either an `HTMLCanvasElement` (main-thread fallback)
// or an `OffscreenCanvas` (worker). It is the self-driving counterpart of the externally-driven
// `renderLottieFrame`: the demo and the size/perf bench drive frames by hand, whereas a player that
// "just plays" (the worker, and the main-thread fallback) hands that job to this controller.
//
// It deliberately does NOT import a specific player factory: the caller passes `createPlayer`, so
// the SAME controller drives the full player (fill + text + image) or the shapes-only player. That
// is what lets the shapes worker tree-shake the text and image renderers away — the controller's
// module graph never reaches them.

import { type GLEngineContext, runRenderLoop, setGLEngineSize } from "@babylonjs/lite-gl";
import type { LottieFile } from "../animation/lottie-raw.js";
import type { LottiePlayerOptions, LottieVariables } from "../animation/parse.js";
import { createVectorEngine, renderLottieFrame, type LottiePlayer } from "../player/player-core.js";

/** Builds a {@link LottiePlayer} for a document on a given engine. The two stencil-player factories
 *  (`createLottiePlayer`, `createShapePlayer`) both match this shape; the controller is parameterized
 *  by it so it stays renderer-agnostic. */
export type PlayerFactory = (engine: GLEngineContext, file: LottieFile, options?: LottiePlayerOptions, onError?: () => void) => LottiePlayer;

/** Plain-data playback state. All behavior lives in the standalone functions below. */
export interface LottieController {
    /** The lite-gl engine rendering into the controller's canvas. */
    engine: GLEngineContext;
    /** The player (renderer set) driven each frame. */
    player: LottiePlayer;
    /** In point (first comp frame). */
    ip: number;
    /** Out point (exclusive last comp frame). */
    op: number;
    /** Frame rate (frames per second). */
    fr: number;
    /** Frame span `op - ip` (at least 1). */
    span: number;
    /** `performance.now()` timestamp playback started from (reset on resume). */
    startMs: number;
    /** Whether the animation loops; otherwise it holds on the last visible frame. */
    loop: boolean;
    /** Whether the first frame has actually painted. */
    rendered: boolean;
    /** Invoked once, after the first frame paints. */
    onFirstRender?: () => void;
    /** The per-frame callback registered with the engine's render loop. */
    tick: () => void;
}

/** Physical backing-store size for a display size at a device pixel ratio (never smaller than 1×1). */
function backingStore(displayWidth: number, displayHeight: number, dpr: number): [number, number] {
    return [Math.max(1, Math.round(displayWidth * dpr)), Math.max(1, Math.round(displayHeight * dpr))];
}

/**
 * Create a controller: build the engine + player, size the backing store, and prepare the per-frame
 * tick. Does NOT start the loop — call {@link startController}.
 *
 * @param canvas - The render target (a worker `OffscreenCanvas`, or an `HTMLCanvasElement` on the
 *   main-thread fallback).
 * @param file - The parsed Lottie document.
 * @param createPlayer - Factory selecting the renderer set (full vs shapes-only).
 * @param displayWidth - Display width in CSS pixels.
 * @param displayHeight - Display height in CSS pixels.
 * @param dpr - Device pixel ratio for the backing store.
 * @param loop - Whether the animation loops.
 * @param onFirstRender - Invoked once after the first frame paints.
 * @param variables - Runtime text substitutions for localization; applied when the player parses.
 * @param onError - Invoked when an asynchronous renderer resource fails.
 */
export function createController(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    file: LottieFile,
    createPlayer: PlayerFactory,
    displayWidth: number,
    displayHeight: number,
    dpr: number,
    loop: boolean,
    onFirstRender?: () => void,
    variables?: LottieVariables,
    onError?: () => void
): LottieController {
    const engine = createVectorEngine(canvas);
    const player = createPlayer(engine, file, { variables }, onError);
    const [bw, bh] = backingStore(displayWidth, displayHeight, dpr);
    setGLEngineSize(engine, bw, bh);

    const ip = file.ip ?? 0;
    const op = file.op ?? 60;
    const fr = file.fr ?? 30;
    const controller: LottieController = {
        engine,
        player,
        ip,
        op,
        fr,
        span: Math.max(1, op - ip),
        startMs: performance.now(),
        loop,
        rendered: false,
        onFirstRender,
        tick: () => {},
    };

    controller.tick = () => {
        const elapsedFrames = ((performance.now() - controller.startMs) / 1000) * controller.fr;
        // Loop wraps within [ip, op); non-loop clamps to the last visible frame (op is exclusive).
        const frame = controller.loop ? controller.ip + (elapsedFrames % controller.span) : Math.min(controller.ip + elapsedFrames, controller.op - 1);
        // `renderLottieFrame` is a no-op until every effect has compiled; fire the first-render hook
        // only once a frame has genuinely painted.
        if (renderLottieFrame(controller.player, frame) && !controller.rendered) {
            controller.rendered = true;
            controller.onFirstRender?.();
        }
    };

    return controller;
}

/** Start (or restart) playback from the current moment, registering the tick with the engine's
 *  requestAnimationFrame loop. */
export function startController(controller: LottieController): void {
    controller.startMs = performance.now();
    runRenderLoop(controller.engine, controller.tick);
}

/** Re-size the backing store after a container/display-size change. Aspect-fit is handled per frame
 *  by `renderLottieFrame`, so only the drawing-buffer resolution changes here. */
export function resizeController(controller: LottieController, displayWidth: number, displayHeight: number, dpr: number): void {
    const [bw, bh] = backingStore(displayWidth, displayHeight, dpr);
    setGLEngineSize(controller.engine, bw, bh);
}
