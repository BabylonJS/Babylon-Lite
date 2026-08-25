import {
    applyEffectWrapper,
    createEffectWrapper,
    createGLEngine,
    drawEffect,
    isEffectReady,
    resizeGLEngine,
    runRenderLoop,
    setEffectFloat,
    setEffectFloat2,
    setViewport,
    stopRenderLoop,
} from "babylon-lite-gl";

/** Options for {@link runFullscreenEffect}. */
export interface FullscreenEffectOptions {
    /** Debug name for the compiled effect. */
    name: string;
    /** GLSL ES 3.00 fragment source. Receives `uTime` (seconds) and
     *  `uResolution` (drawing-buffer pixels) uniforms, plus a `vUv` varying. */
    fragmentSource: string;
}

/**
 * Parse the parity harness's `?seekTime=<seconds>` query parameter.
 *
 * Returns the freeze time in seconds, or `null` when the parameter is absent or
 * not a finite number — in which case the scene animates on the wall clock as
 * usual. The deterministic freeze is what makes a lite render directly
 * comparable to the Babylon.js reference (see tests/gl/parity).
 */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Bootstraps a single animated fullscreen effect on `#renderCanvas` using the
 * `@babylonjs/lite-gl` package. This is the user-facing reference for the lite-gl
 * API — it reads like a high-level demo, not a raw WebGL tutorial.
 *
 * Sets `canvas.dataset.ready = "true"` after the first rendered frame so the
 * lab loader overlay fades out and screenshot tooling can detect readiness, and
 * stamps `canvas.dataset.initMs` / `dataset.drawCalls` for the perf harness.
 *
 * Determinism: when the page is opened with `?seekTime=<seconds>`, the effect
 * renders EXACTLY ONE frame with `uTime = seekTime` (the wall clock is NOT
 * advanced), then stamps `canvas.dataset.animationFrozen = "true"` and stops the
 * render loop so a screenshot is stable. Without the parameter the scene
 * animates normally on `performance.now()`.
 */
export function runFullscreenEffect(opts: FullscreenEffectOptions): void {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = createGLEngine(canvas, { alpha: false });

    // The wrapper compiles + owns the effect; vertexSource defaults to the
    // package's built-in fullscreen-quad shader, so only fragmentSource is needed.
    const wrapper = createEffectWrapper(engine, {
        name: opts.name,
        fragmentSource: opts.fragmentSource,
        uniformNames: ["uTime", "uResolution"],
    });
    const effect = wrapper.effect;

    const seekTime = parseSeekTime();
    const startMs = performance.now();
    let firstFrameDrawn = false;

    runRenderLoop(engine, () => {
        if (!isEffectReady(engine, effect)) {
            return;
        }
        resizeGLEngine(engine);
        setViewport(engine);
        applyEffectWrapper(wrapper);
        // Frozen capture pins uTime to seekTime; otherwise advance on wall clock.
        const uTime = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
        setEffectFloat(engine, effect, "uTime", uTime);
        setEffectFloat2(engine, effect, "uResolution", canvas.width, canvas.height);
        drawEffect(engine);
        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = "1";
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
            if (seekTime !== null) {
                // Deterministic single-frame capture: freeze + halt so the
                // screenshot is stable and matches the BJS reference exactly.
                canvas.dataset.animationFrozen = "true";
                stopRenderLoop(engine);
            }
        }
    });
}
