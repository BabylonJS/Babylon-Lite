/** WebXR session modes Babylon Lite supports. */
export type XrSessionMode = "immersive-vr" | "immersive-ar";

/**
 * Which eye a view renders. Structurally identical to the DOM `XREye` alias, but
 * declared locally so the public `.d.ts` rollup (api-extractor) never has to
 * follow an ambient `@types/webxr` type alias.
 */
export type XrEye = "none" | "left" | "right";

/** Handedness of an XR input source. Local mirror of the DOM `XRHandedness` alias. */
export type XrHandedness = "none" | "left" | "right";

/** Target-ray mode of an XR input source. Local mirror of the DOM `XRTargetRayMode` alias. */
export type XrTargetRayMode = "gaze" | "tracked-pointer" | "screen" | "transient-pointer";

/** Reference-space type for an XR session. Local mirror of the DOM `XRReferenceSpaceType` alias. */
export type XrReferenceSpaceType = "viewer" | "local" | "local-floor" | "bounded-floor" | "unbounded";

/** Whether the WebXR Device API is present at all (`navigator.xr`). */
export function isWebXrPresent(): boolean {
    return typeof navigator !== "undefined" && "xr" in navigator && !!navigator.xr;
}

/**
 * Whether the **draft** WebXR/WebGPU binding is implemented by this UA — i.e. the
 * global `XRGPUBinding` constructor exists. No browser ships it yet, so this
 * returns `false` everywhere today; it is the single gate the rest of the XR code
 * checks before attempting a WebGPU XR session.
 */
export function isWebGpuXrSupported(): boolean {
    return typeof XRGPUBinding !== "undefined";
}

/**
 * Resolve whether a given immersive session mode is supported, combining the
 * WebXR device check, the draft WebGPU-binding check, and the UA's
 * `isSessionSupported` answer. Never throws — returns `false` on any failure.
 *
 * @param mode - `"immersive-vr"` or `"immersive-ar"`.
 */
export async function isXrSessionSupported(mode: XrSessionMode): Promise<boolean> {
    if (!isWebXrPresent() || !isWebGpuXrSupported()) {
        return false;
    }
    try {
        return (await navigator.xr!.isSessionSupported(mode)) === true;
    } catch {
        return false;
    }
}
