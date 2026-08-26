import { type Nullable } from "./babylonTypes";
import { type AnimationInput } from "./types";
import {
    type AnimationSizeMessagePayload,
    type AnimationUrlMessage,
    type ContainerResizeMessage,
    type DisposeMessage,
    type Message,
    type StartAnimationMessage,
    type PreWarmMessage,
    type WorkerLoadedMessagePayload,
} from "./messageTypes";
import { type RawLottieAnimation } from "./parsing/rawTypes";
import { CalculateScaleFactors, type ScaleFactors } from "./rendering/calculateScaleFactor";
// Imported as `Worker` so webpack statically detects the `new Worker(new URL("./workerEntry", import.meta.url))`
// form used in GetOrCreateWorker, emits the worker as its own (classic) chunk, and rewrites the URL.
// BlobWorkerWrapper then wraps that rewritten URL in a classic `importScripts` blob so a strict, CDN-friendly
// CSP only needs `worker-src blob:` (and, because classic importScripts is no-CORS, no CORS on the CDN).
import { BlobWorkerWrapper as Worker } from "./blobWorkerWrapper";

/**
 * Plain-data state for the worker-backed Lottie player.
 *
 * The player is purely functional: this object holds only data, and all behavior lives in the
 * standalone functions below. A single state object can only be used to play one animation; create a
 * new state with {@link CreatePlayer} for each animation.
 */
export type PlayerState = {
    /** Input parameters for the animation currently being played, or `null` before playback starts. */
    input: Nullable<AnimationInput>;
    /** Whether the player has started playing an animation. */
    playing: boolean;
    /** Whether the player has been disposed. */
    disposed: boolean;
    /** Whether the worker has finished pre-warming. */
    preWarmed: boolean;
    /** Promise that resolves when pre-warming completes, or `null` when no pre-warm is in flight. */
    preWarmPromise: Promise<PlayerState> | null;
    /** Resolver for {@link preWarmPromise}. */
    preWarmResolve: ((state: PlayerState) => void) | null;
    /** Rejecter for {@link preWarmPromise}. */
    preWarmReject: ((reason?: any) => void) | null;
    /** The worker that renders the animation off the main thread. */
    worker: Nullable<globalThis.Worker>;
    /** The canvas whose control is transferred to the worker as an `OffscreenCanvas`. */
    canvas: Nullable<HTMLCanvasElement>;
    /** Intrinsic width of the animation in pixels. */
    animationWidth: number;
    /** Intrinsic height of the animation in pixels. */
    animationHeight: number;
    /** Canvas/atlas scale factors derived from the container size. */
    scaleFactors: ScaleFactors;
    /** Observer that reacts to container resizes, or `null` when not observing. */
    resizeObserver: Nullable<ResizeObserver>;
    /** Pending debounced resize timeout handle, or `null` when none is scheduled. */
    resizeDebounceHandle: number | null;
    /** Debounce interval for resize updates, in milliseconds. */
    resizeDebounceMs: number;
    /** Stable `beforeunload` listener reference so it can be added and removed. */
    onBeforeUnload: () => void;
};

/**
 * Creates a new worker-backed Lottie player state.
 * If OffscreenCanvas is not supported by the browser, the animation will not play. Use the local player instead.
 * @returns A fresh {@link PlayerState}.
 * @throws Error if OffscreenCanvas is not supported.
 */
export function CreatePlayer(): PlayerState {
    // Check if OffscreenCanvas is supported
    if (!("OffscreenCanvas" in window)) {
        throw new Error("OffscreenCanvas not supported - cannot create Player");
    }

    const state: PlayerState = {
        input: null,
        playing: false,
        disposed: false,
        preWarmed: false,
        preWarmPromise: null,
        preWarmResolve: null,
        preWarmReject: null,
        worker: null,
        canvas: null,
        animationWidth: 0,
        animationHeight: 0,
        scaleFactors: { canvasScale: 1, atlasScale: 1 },
        resizeObserver: null,
        resizeDebounceHandle: null,
        resizeDebounceMs: 1000 / 60, // Debounce resize updates to approximately 60 FPS
        onBeforeUnload: () => {},
    };

    state.onBeforeUnload = () => {
        state.worker?.terminate();
        state.worker = null;
    };

    return state;
}

/**
 * Pre-warms the worker by loading necessary code ahead of time.
 * This promise resolves when the worker has loaded all the code required to play an animation.
 * @param state The player state.
 * @returns A Promise that resolves to the player state when the worker is ready.
 * @throws Error if the player is already playing or disposed.
 */
export async function PreWarmPlayerAsync(state: PlayerState): Promise<PlayerState> {
    if (state.playing || state.disposed) {
        throw new Error("Invalid call to PreWarmPlayerAsync - player is already playing or disposed");
    }

    if (state.preWarmed) {
        return state;
    }

    // Pre-warming already in progress
    if (state.preWarmPromise) {
        return await state.preWarmPromise;
    }

    // Create the promise that will be resolved when we receive the "loaded" message
    state.preWarmPromise = new Promise<PlayerState>((resolve, reject) => {
        state.preWarmResolve = resolve;
        state.preWarmReject = reject;
    });

    // Initialize worker if not already done
    const worker = GetOrCreateWorker(state);

    // Send pre-warm message to worker
    const preWarmMessage: PreWarmMessage = {
        type: "preWarm",
        payload: {},
    };

    worker.postMessage(preWarmMessage);

    return await state.preWarmPromise;
}

/**
 * Loads and plays a lottie animation using a webworker and offscreen canvas.
 * @param state The player state.
 * @param input Input parameters required to load and play the animation.
 * @returns True if the animation is successfully set up to play, false if the animation couldn't play.
 */
export async function PlayAnimationAsync(state: PlayerState, input: AnimationInput): Promise<boolean> {
    if (state.playing || state.disposed) {
        return false;
    }

    state.input = input;

    // Set up resize observer to handle container resizing
    if ("ResizeObserver" in window) {
        state.resizeObserver = new ResizeObserver(() => {
            ScheduleResizeUpdate(state);
        });
        state.resizeObserver.observe(state.input.container);
    }

    // If we are pre-warming, wait for it to complete
    if (state.preWarmPromise) {
        try {
            await state.preWarmPromise;
        } catch {
            return false;
        }
    }

    // Initialize worker if not already done by pre-warming
    const worker = GetOrCreateWorker(state);

    if (typeof state.input.animationSource === "string") {
        // Resolve the URL against the main-thread document base before handing it to the worker: the
        // worker script has a different base URL, so a relative source (e.g. "./anim.json") would
        // otherwise resolve against the worker's own location and fail to load.
        const url = new URL(state.input.animationSource, location.href).href;
        const animationUrlMessage: AnimationUrlMessage = {
            type: "animationUrl",
            payload: {
                url,
            },
        };
        worker.postMessage(animationUrlMessage);
    } else {
        // We have the raw animation data already on this thread
        CreateCanvasAndStartAnimation(state, state.input.animationSource);
    }

    return true;
}

/**
 * Disposes the player state, cleaning up resources and event listeners.
 * @param state The player state.
 */
export function DisposePlayer(state: PlayerState): void {
    if (state.resizeObserver) {
        state.resizeObserver.disconnect();
        state.resizeObserver = null;
    }

    if (state.resizeDebounceHandle !== null) {
        clearTimeout(state.resizeDebounceHandle);
        state.resizeDebounceHandle = null;
    }

    // Clean up pre-warm promise
    if (state.preWarmReject) {
        state.preWarmReject(new Error("Player disposed"));
    }

    state.preWarmResolve = null;
    state.preWarmReject = null;
    state.preWarmPromise = null;

    if (state.worker) {
        // Try graceful shutdown first
        const disposeMessage: DisposeMessage = {
            type: "dispose",
            payload: {},
        };

        state.worker.postMessage(disposeMessage);
        state.worker = null;
        window.removeEventListener("beforeunload", state.onBeforeUnload);
    }

    if (state.input && state.canvas) {
        state.input.container.removeChild(state.canvas);
    }

    state.canvas = null;

    state.disposed = true;
}

function GetOrCreateWorker(state: PlayerState): globalThis.Worker {
    if (!state.worker) {
        // `Worker` is BlobWorkerWrapper (aliased on import). Webpack sees the literal
        // `new Worker(new URL("./workerEntry", import.meta.url))` form, emits workerEntry as its own classic
        // worker chunk, and rewrites the URL; the wrapper then loads it via a CSP-friendly `importScripts`
        // blob (no CORS required). The worker uses dynamic import() to lazily pull in the parser, the lite-gl
        // render controller, and the per-animation feature chunks (webpack loads those via importScripts too,
        // re-pointed at the CDN by the wrapper's importScripts override).
        const wrapperWorker = new Worker(new URL("./workerEntry", import.meta.url));
        state.worker = wrapperWorker.getWorker();
        state.worker.onmessage = (evt: MessageEvent) => {
            HandleWorkerMessage(state, evt);
        };

        window.addEventListener("beforeunload", state.onBeforeUnload);
    }

    return state.worker;
}

function CreateCanvasAndStartAnimation(state: PlayerState, animationData: RawLottieAnimation | AnimationSizeMessagePayload): void {
    if (state.input === null || state.worker === null) {
        return;
    }

    if (IsRawLottieAnimation(animationData)) {
        state.animationWidth = animationData.w;
        state.animationHeight = animationData.h;
    } else {
        state.animationWidth = animationData.width;
        state.animationHeight = animationData.height;
    }

    // Create the canvas element
    state.canvas = document.createElement("canvas");
    state.canvas.id = "babylon-canvas";

    // The size of the canvas is the relation between the size of the container div and the size of the animation
    state.scaleFactors = CalculateScaleFactors(state.animationWidth, state.animationHeight, state.input.container);
    state.canvas.style.width = `${state.animationWidth * state.scaleFactors.canvasScale}px`;
    state.canvas.style.height = `${state.animationHeight * state.scaleFactors.canvasScale}px`;

    // Append the canvas to the container
    state.input.container.appendChild(state.canvas);
    const offscreen = state.canvas.transferControlToOffscreen();

    const startAnimationMessage: StartAnimationMessage = {
        type: "startAnimation",
        payload: {
            canvas: offscreen,
            canvasScale: state.scaleFactors.canvasScale,
            atlasScale: state.scaleFactors.atlasScale,
            variables: state.input.variables,
            configuration: state.input.configuration,
            animationData: IsRawLottieAnimation(animationData) ? animationData : undefined,
            mainThreadDevicePixelRatio: window.devicePixelRatio,
        },
    };

    state.worker.postMessage(startAnimationMessage, [offscreen]);
    state.playing = true;
}

function HandleWorkerMessage(state: PlayerState, evt: MessageEvent): void {
    const message = evt.data as Message;
    if (message === undefined) {
        return;
    }

    switch (message.type) {
        case "animationSize": {
            if (state.worker === null) {
                return;
            }

            CreateCanvasAndStartAnimation(state, message.payload as AnimationSizeMessagePayload);
            break;
        }
        case "workerLoaded": {
            const payload = message.payload as WorkerLoadedMessagePayload;
            if (payload.success) {
                state.preWarmed = true;
                state.preWarmResolve?.(state);
            } else {
                state.preWarmReject?.(new Error(payload.error || "Pre-warming failed"));
            }

            // Clean up promise handlers
            state.preWarmResolve = null;
            state.preWarmReject = null;
            state.preWarmPromise = null;
            break;
        }
        case "firstRender": {
            state.input?.onFirstRender?.();
            break;
        }
    }
}

function ScheduleResizeUpdate(state: PlayerState): void {
    if (state.disposed || !state.input || !state.canvas || !state.worker) {
        return;
    }

    if (state.animationWidth === 0 || state.animationHeight === 0) {
        return; // Not initialized yet
    }

    if (state.resizeDebounceHandle !== null) {
        clearTimeout(state.resizeDebounceHandle);
    }

    state.resizeDebounceHandle = window.setTimeout(() => {
        state.resizeDebounceHandle = null;
        if (state.disposed || !state.input || !state.canvas || !state.worker) {
            return;
        }

        const newScaleFactors = CalculateScaleFactors(state.animationWidth, state.animationHeight, state.input.container);
        if (state.scaleFactors.canvasScale !== newScaleFactors.canvasScale) {
            state.scaleFactors = newScaleFactors;

            state.canvas.style.width = `${state.animationWidth * newScaleFactors.canvasScale}px`;
            state.canvas.style.height = `${state.animationHeight * newScaleFactors.canvasScale}px`;

            const containerResizeMessage: ContainerResizeMessage = {
                type: "containerResize",
                payload: { canvasScale: newScaleFactors.canvasScale },
            };
            state.worker.postMessage(containerResizeMessage);
        }
    }, state.resizeDebounceMs);
}

function IsRawLottieAnimation(x: unknown): x is RawLottieAnimation {
    const o = x as any;
    return !!o && typeof o === "object" && typeof o.w === "number" && typeof o.h === "number" && Array.isArray(o.layers);
}
