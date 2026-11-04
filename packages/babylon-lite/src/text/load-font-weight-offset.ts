import type { setFontWeightOffset } from "./set-font-weight-offset.js";

/**
 * Load the synthetic font-weight setter without dynamically importing the package barrel.
 *
 * The exact internal import keeps the opt-in shader feature isolated in its lazy chunk
 * while the package continues to expose a single root entry point.
 */
export async function loadFontWeightOffset(): Promise<typeof setFontWeightOffset> {
    return (await import("./set-font-weight-offset.js")).setFontWeightOffset;
}
