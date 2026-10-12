import type { GaussianSplatStream } from "babylon-lite";

/** Applies the scene orientation authored by the published Trogir viewer. */
export function placeTrogirStream(stream: GaussianSplatStream): void {
    // This is viewer-authored placement, not part of the generic SOG coordinate conversion.
    stream.rotation.z = Math.PI;
}
