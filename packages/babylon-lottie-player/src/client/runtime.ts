// Main-thread runtime for the worker-backed Lottie player — the public-API counterpart of the
// in-worker dispatcher. It owns the DOM `<canvas>`, its layout and resize handling, and the message
// conversation with the worker; the worker owns the engine and the render loop. The render work
// (parse, tessellation, GPU submission) happens entirely off the main thread.
//
// This module is renderer- AND variant-agnostic: a player is created with a `spawn` callback that
// knows how to construct the right worker (full or shapes-only). The thin `full-client` /
// `shapes-client` modules bake in that callback; everything else is shared here. Keeping the worker
// URL out of this module is what lets the shapes client avoid pulling the full worker chunk into its
// graph (and vice versa).

import type { LottieFile } from "../animation/lottie-raw.js";
import type { LottieVariables } from "../animation/parse.js";
import type { StartMessage, WorkerOutbound } from "../worker/protocol.js";

declare const lottieWorkerPlayerBrand: unique symbol;

/** Input for {@link playWorkerAnimationAsync}. */
export interface LottieWorkerInput {
    /** Element the animation canvas is appended to and sized against. */
    container: HTMLElement;
    /** A URL to fetch the Lottie JSON from (the full player resolves external images from its final
     *  response URL), or a parsed document whose external image URLs must already be absolute. */
    animationSource: string | LottieFile;
    /** Whether the animation loops; otherwise it holds on the last frame. Defaults to `true`. */
    loop?: boolean;
    /** Runtime text substitutions for localization (whole-string key match), applied when the worker
     *  parses the document. */
    variables?: LottieVariables;
    /** Invoked once, after the first frame paints. */
    onFirstRender?: () => void;
    /** Invoked if the render worker fails. */
    onError?: () => void;
}

/** Opaque handle for one worker-backed animation player. */
export interface LottieWorkerPlayer {
    readonly [lottieWorkerPlayerBrand]: true;
    /** @internal How to construct the worker (variant-specific). */
    spawn: () => Worker;
    /** @internal The render worker, `null` before use, or `false` after disposal. */
    worker: Worker | null | false;
    /** @internal The DOM canvas whose control is transferred to the worker. */
    canvas: HTMLCanvasElement | null;
    /** @internal Input for the animation being played, or `null` before playback. */
    input: LottieWorkerInput | null;
    /** @internal Intrinsic animation width in pixels (known after load). */
    animWidth: number;
    /** @internal Intrinsic animation height in pixels. */
    animHeight: number;
    /** @internal Container resize observer, or `null` when not observing. */
    resizeObserver: ResizeObserver | null;
}

/** Current device pixel ratio, defaulting to 1 where unavailable. */
function dpr(): number {
    return typeof window !== "undefined" && typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1;
}

/** Contain-fit the animation into the container's content box, in CSS pixels. Falls back to the
 *  intrinsic size when the container has not been laid out yet. */
function computeFit(animWidth: number, animHeight: number, container: HTMLElement): [number, number] {
    const cw = container.clientWidth || animWidth;
    const ch = container.clientHeight || animHeight;
    const raw = Math.min(cw / animWidth, ch / animHeight);
    const scale = raw > 0 && Number.isFinite(raw) ? raw : 1;
    return [Math.max(1, animWidth * scale), Math.max(1, animHeight * scale)];
}

/**
 * Create a worker-backed player. Throws if the environment lacks `OffscreenCanvas` /
 * `transferControlToOffscreen`.
 * @param spawn - Constructs the worker for the desired variant.
 */
export function createWorkerPlayer(spawn: () => Worker): LottieWorkerPlayer {
    if (typeof OffscreenCanvas === "undefined" || typeof HTMLCanvasElement === "undefined" || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
        throw new Error("lite: OffscreenCanvas not supported");
    }
    const player = {
        spawn,
        worker: null,
        canvas: null,
        input: null,
        animWidth: 0,
        animHeight: 0,
        resizeObserver: null,
    } as unknown as LottieWorkerPlayer;
    return player;
}

/**
 * Load and play an animation off the main thread. A URL source is fetched + parsed in the worker;
 * a parsed document is sized and started without a round trip.
 * @param player - The player state.
 * @param input - The animation to play.
 * @returns `true` if playback was set up, `false` if the player is already playing or disposed.
 */
export async function playWorkerAnimationAsync(player: LottieWorkerPlayer, input: LottieWorkerInput): Promise<boolean> {
    if (player.worker !== null) {
        return false;
    }
    player.input = input;
    const worker = ensureWorker(player);

    if (typeof input.animationSource === "string") {
        // Resolve relative to the document base before handing the worker an absolute URL — the
        // worker script has a different base URL, so a relative source would resolve incorrectly.
        const url = new URL(input.animationSource, location.href).href;
        worker.postMessage({ type: "load", url });
    } else {
        startWithSize(player, input.animationSource.w, input.animationSource.h, input.animationSource);
    }
    return true;
}

function ensureWorker(player: LottieWorkerPlayer): Worker {
    const worker = player.spawn();
    player.worker = worker;
    worker.onmessage = (event: MessageEvent) => handleMessage(player, event);
    worker.onerror = worker.onmessageerror = () => fail(player);
    return worker;
}

function handleMessage(player: LottieWorkerPlayer, event: MessageEvent): void {
    const message = event.data as WorkerOutbound | undefined;
    if (!message) {
        return;
    }
    switch (message.type) {
        case "size": {
            // URL path: the worker parsed the document and reported its intrinsic size — now size the
            // canvas and hand the worker its control (the worker already holds the parsed document).
            startWithSize(player, message.width, message.height, undefined);
            break;
        }
        case "firstRender": {
            player.input?.onFirstRender?.();
            break;
        }
        case "error": {
            fail(player);
            break;
        }
    }
}

function fail(player: LottieWorkerPlayer): void {
    if (!player.worker) {
        return;
    }
    disposeWorkerPlayer(player);
    player.input?.onError?.();
}

function startWithSize(player: LottieWorkerPlayer, animWidth: number, animHeight: number, file: LottieFile | undefined): void {
    if (player.input === null || !player.worker) {
        return;
    }
    player.animWidth = animWidth;
    player.animHeight = animHeight;

    const canvas = document.createElement("canvas");
    const [displayWidth, displayHeight] = computeFit(animWidth, animHeight, player.input.container);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    player.input.container.appendChild(canvas);
    player.canvas = canvas;

    const offscreen = canvas.transferControlToOffscreen();
    const start: StartMessage = {
        type: "start",
        canvas: offscreen,
        file,
        displayWidth,
        displayHeight,
        devicePixelRatio: dpr(),
        loop: player.input.loop ?? true,
        variables: player.input.variables,
    };
    player.worker.postMessage(start, [offscreen]);

    observeResize(player);
}

/**
 * Dispose the player: stop the worker, drop the canvas, and remove listeners. Idempotent.
 * @param player - The player state.
 */
export function disposeWorkerPlayer(player: LottieWorkerPlayer): void {
    if (player.resizeObserver) {
        player.resizeObserver.disconnect();
        player.resizeObserver = null;
    }
    if (player.worker) {
        player.worker.terminate();
    }
    player.worker = false;
    if (player.input && player.canvas && player.canvas.parentNode === player.input.container) {
        player.input.container.removeChild(player.canvas);
    }
    player.canvas = null;
}

function observeResize(player: LottieWorkerPlayer): void {
    if (typeof ResizeObserver === "undefined" || player.input === null) {
        return;
    }
    player.resizeObserver = new ResizeObserver(() => resize(player));
    player.resizeObserver.observe(player.input.container);
}

function resize(player: LottieWorkerPlayer): void {
    if (player.input === null || player.canvas === null || !player.worker || player.animWidth === 0) {
        return;
    }
    const [displayWidth, displayHeight] = computeFit(player.animWidth, player.animHeight, player.input.container);
    player.canvas.style.width = `${displayWidth}px`;
    player.canvas.style.height = `${displayHeight}px`;
    player.worker.postMessage({ type: "resize", displayWidth, displayHeight, devicePixelRatio: dpr() });
}
