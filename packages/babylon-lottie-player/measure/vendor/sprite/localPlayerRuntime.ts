import { type Nullable } from "./babylonTypes";
import { type AnimationInput } from "./types";
import { type RawLottieAnimation } from "./parsing/rawTypes";
import { type ScaleFactors, CalculateScaleFactors } from "./rendering/calculateScaleFactor";

import { GetRawAnimationDataAsync } from "./parsing/rawAnimation";
import { type AnimationController, createAnimationControllerAsync, disposeAnimationController, playAnimation, setControllerScale } from "./rendering/animationController";

/**
 * Plain-data state for the main-thread Lottie player (used for local testing / debugging and as a
 * no-OffscreenCanvas fallback; not part of the public API).
 *
 * Purely functional: this object holds only data, and all behavior lives in the standalone functions
 * below. A single state object can only be used to play one animation; create a new state with
 * {@link CreateLocalPlayer} for each animation.
 */
export type LocalPlayerState = {
    /** Input parameters for the animation currently being played, or `null` before playback starts. */
    input: Nullable<AnimationInput>;
    /** The parsed raw animation data, or `undefined` before it has been loaded. */
    rawAnimation: RawLottieAnimation | undefined;
    /** Canvas/atlas scale factors derived from the container size. */
    scaleFactors: ScaleFactors;
    /** Whether the player has started playing an animation. */
    playing: boolean;
    /** Whether the player has been disposed. */
    disposed: boolean;
    /** The canvas the animation renders into. */
    canvas: HTMLCanvasElement | null;
    /** Observer that reacts to container resizes, or `null` when not observing. */
    resizeObserver: ResizeObserver | null;
    /** The controller that drives rendering on the main thread. */
    animationController: AnimationController | null;
    /** Pending debounced resize timeout handle, or `null` when none is scheduled. */
    resizeDebounceHandle: number | null;
    /** Debounce interval for resize updates, in milliseconds. */
    resizeDebounceMs: number;
};

/**
 * Creates a new main-thread Lottie player state.
 * @returns A fresh {@link LocalPlayerState}.
 */
export function CreateLocalPlayer(): LocalPlayerState {
    return {
        input: null,
        rawAnimation: undefined,
        scaleFactors: { canvasScale: 1, atlasScale: 1 },
        playing: false,
        disposed: false,
        canvas: null,
        resizeObserver: null,
        animationController: null,
        resizeDebounceHandle: null,
        resizeDebounceMs: 1000 / 60, // Debounce resize updates to approximately 60 FPS
    };
}

/**
 * Loads and plays a lottie animation on the main thread.
 * @param state The local player state.
 * @param input Input parameters required to load and play the animation.
 * @returns True if the animation is successfully set up to play, false if the animation couldn't play.
 */
export async function PlayLocalAnimationAsync(state: LocalPlayerState, input: AnimationInput): Promise<boolean> {
    if (state.playing || state.disposed) {
        return false;
    }

    state.input = input;

    // Load the animation from URL or use the provided parsed JSON
    const rawAnimation = typeof input.animationSource === "string" ? await GetRawAnimationDataAsync(input.animationSource) : input.animationSource;

    // Create the canvas element
    const canvas = document.createElement("canvas");
    canvas.id = "babylon-canvas";

    // The size of the canvas is the relation between the size of the container div and the size of the animation
    const scaleFactors = CalculateScaleFactors(rawAnimation.w, rawAnimation.h, input.container);
    canvas.style.width = `${rawAnimation.w * scaleFactors.canvasScale}px`;
    canvas.style.height = `${rawAnimation.h * scaleFactors.canvasScale}px`;

    // Append the canvas to the container
    input.container.appendChild(canvas);

    const animationController = await createAnimationControllerAsync(
        canvas,
        rawAnimation,
        scaleFactors.canvasScale,
        scaleFactors.atlasScale,
        input.variables ?? new Map<string, string>(),
        input.configuration ?? {},
        undefined, // mainThreadDevicePixelRatio not needed for main thread
        input.onFirstRender
    );
    playAnimation(animationController);

    // Commit everything derived from the awaited work to `state` in a single synchronous step.
    CommitAnimation(state, input, rawAnimation, canvas, scaleFactors, animationController);

    return true;
}

function CommitAnimation(
    state: LocalPlayerState,
    input: AnimationInput,
    rawAnimation: RawLottieAnimation,
    canvas: HTMLCanvasElement,
    scaleFactors: ScaleFactors,
    animationController: AnimationController
): void {
    state.rawAnimation = rawAnimation;
    state.canvas = canvas;
    state.scaleFactors = scaleFactors;
    state.animationController = animationController;
    state.playing = true;

    if ("ResizeObserver" in window) {
        state.resizeObserver = new ResizeObserver(() => {
            ScheduleResizeUpdate(state);
        });
        state.resizeObserver.observe(input.container);
    }
}

/**
 * Disposes the local player state, cleaning up resources and event listeners.
 * @param state The local player state.
 */
export function DisposeLocalPlayer(state: LocalPlayerState): void {
    if (state.resizeObserver) {
        state.resizeObserver.disconnect();
        state.resizeObserver = null;
    }

    if (state.resizeDebounceHandle !== null) {
        clearTimeout(state.resizeDebounceHandle);
        state.resizeDebounceHandle = null;
    }

    if (state.input && state.canvas) {
        state.input.container.removeChild(state.canvas);
    }

    if (state.animationController) {
        disposeAnimationController(state.animationController);
        state.animationController = null;
    }

    state.canvas = null;

    state.disposed = true;
}

function ScheduleResizeUpdate(state: LocalPlayerState): void {
    if (state.disposed || !state.input || !state.canvas || !state.rawAnimation || state.animationController === null) {
        return;
    }

    if (state.resizeDebounceHandle !== null) {
        clearTimeout(state.resizeDebounceHandle);
    }

    state.resizeDebounceHandle = window.setTimeout(() => {
        state.resizeDebounceHandle = null;
        if (state.disposed || !state.input || !state.canvas || !state.rawAnimation || state.animationController === null) {
            return;
        }

        const newScaleFactors = CalculateScaleFactors(state.rawAnimation.w, state.rawAnimation.h, state.input.container);
        if (state.scaleFactors.canvasScale !== newScaleFactors.canvasScale) {
            state.scaleFactors = newScaleFactors;

            state.canvas.style.width = `${state.rawAnimation.w * newScaleFactors.canvasScale}px`;
            state.canvas.style.height = `${state.rawAnimation.h * newScaleFactors.canvasScale}px`;
            setControllerScale(state.animationController, newScaleFactors.canvasScale);
        }
    }, state.resizeDebounceMs);
}
