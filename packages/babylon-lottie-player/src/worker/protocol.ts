// Message protocol between the main thread and the Lottie render worker.
//
// The worker owns the WebGL2 engine and the per-frame render loop on an OffscreenCanvas; the main
// thread owns the DOM canvas element, its layout/size, and the public player API. These two sides
// exchange exactly the messages below. The same protocol serves both worker variants (full and
// shapes-only) — they differ only in which renderers their dispatcher builds, never in the wire
// format.
//
// Flow:
//   • URL source:  main → "load" → worker fetches+parses → "size" → main sizes+transfers the canvas
//     → "start". Fetch + JSON parse happen off the main thread.
//   • raw-JSON source:  main already knows the size, so it sizes+transfers immediately and sends the
//     parsed document inline with "start" (no round trip).
//   • resize:  main → worker whenever the container's content box changes.

import type { LottieFile } from "../animation/lottie-raw.js";
import type { LottieVariables } from "../animation/parse.js";

/** Ask the worker to fetch + parse a Lottie document from a URL. Main → worker. */
export interface LoadMessage {
    type: "load";
    /** Absolute URL (already resolved against the document base on the main thread). */
    url: string;
}

/** Begin rendering on the transferred OffscreenCanvas. Main → worker.
 *  `file` is present only for the raw-JSON path; for the URL path the worker already holds the
 *  document it parsed in response to {@link LoadMessage}. */
export interface StartMessage {
    type: "start";
    /** The canvas whose control was transferred from the main thread. */
    canvas: OffscreenCanvas;
    /** Parsed document for the raw-JSON path; omitted for the URL path. */
    file?: LottieFile;
    /** Target display width in CSS pixels (the worker multiplies by `dpr` for the backing store). */
    displayWidth: number;
    /** Target display height in CSS pixels. */
    displayHeight: number;
    /** The main thread's `devicePixelRatio` (workers cannot read it). */
    devicePixelRatio: number;
    /** Whether the animation loops (otherwise it holds on the last frame). */
    loop: boolean;
    /** Runtime text substitutions for localization (whole-string key match), applied when the worker parses. */
    variables?: LottieVariables;
}

/** The container's content box changed; re-size the backing store. Main → worker. */
export interface ResizeMessage {
    type: "resize";
    /** New display width in CSS pixels. */
    displayWidth: number;
    /** New display height in CSS pixels. */
    displayHeight: number;
    /** Current `devicePixelRatio`. */
    devicePixelRatio: number;
}

/** Any message the main thread sends to the worker. */
export type WorkerInbound = LoadMessage | StartMessage | ResizeMessage;

/** The intrinsic size of the animation the worker loaded from a URL. Worker → main. */
export interface SizeMessage {
    type: "size";
    /** Intrinsic comp width in pixels. */
    width: number;
    /** Intrinsic comp height in pixels. */
    height: number;
}

/** The first frame has actually painted (all GPU effects compiled). Worker → main. */
export interface FirstRenderMessage {
    type: "firstRender";
}

/** The worker failed (load/parse/engine error). Worker → main. */
export interface ErrorMessage {
    type: "error";
}

/** Any message the worker sends to the main thread. */
export type WorkerOutbound = SizeMessage | FirstRenderMessage | ErrorMessage;
