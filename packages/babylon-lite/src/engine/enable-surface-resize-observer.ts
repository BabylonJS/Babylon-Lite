import { isDomCanvas, type SurfaceContext } from "./surface.js";

/**
 * Cache a DOM surface's CSS dimensions with `ResizeObserver`, avoiding layout reads
 * from the per-frame `resizeSurface` call. Returns a disposer.
 */
export function enableSurfaceResizeObserver(surface: SurfaceContext): () => void {
    if (!isDomCanvas(surface.canvas) || typeof ResizeObserver === "undefined") {
        return () => undefined;
    }
    surface._ro?.disconnect();
    const observer = (surface._ro = new ResizeObserver(([entry]) => {
        surface._w = Math.round(entry!.contentRect.width);
        surface._h = Math.round(entry!.contentRect.height);
    }));
    observer.observe(surface.canvas);
    return () => {
        observer.disconnect();
        if (surface._ro === observer) {
            surface._ro = undefined;
            surface._w = surface._h = undefined;
        }
    };
}
