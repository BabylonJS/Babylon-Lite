import { resizeSurface } from "babylon-lite";
import type { EngineContext } from "babylon-lite";

/** Full-resolution accumulation uses 16 bytes per pixel, regardless of the sampling divisor. */
export function installTrogirPointSurfaceLimit(engine: EngineContext, canvas: HTMLCanvasElement, bufferLimit: number): () => void {
    const maxPixels = Math.floor(bufferLimit / 16);
    const previousLimit = engine.maxDevicePixelRatio;
    let disposed = false;
    let resolution: MediaQueryList | null = null;
    const resize = (): void => {
        if (disposed || !(canvas.clientWidth > 0 && canvas.clientHeight > 0)) {
            return;
        }
        engine.maxDevicePixelRatio = Math.min(previousLimit, Math.sqrt(maxPixels / (canvas.clientWidth * canvas.clientHeight)));
        resizeSurface(engine);
    };
    const watchResolution = (): void => {
        if (disposed) {
            return;
        }
        resolution?.removeEventListener("change", watchResolution);
        resolution = window.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`) ?? null;
        resolution?.addEventListener("change", watchResolution);
        resize();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener("resize", resize);
    watchResolution();
    return () => {
        disposed = true;
        observer?.disconnect();
        resolution?.removeEventListener("change", watchResolution);
        window.removeEventListener("resize", resize);
        engine.maxDevicePixelRatio = previousLimit;
    };
}
