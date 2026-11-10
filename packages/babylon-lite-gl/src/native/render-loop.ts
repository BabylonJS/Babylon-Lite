/**
 * Native render loop — the native-backend twin of `render-loop.ts`. Uses the
 * native engine's `requestAnimationFrame` (bgfx-driven) instead of the DOM one,
 * and wraps each frame in a command scope (`beginCommandScope` /
 * `endCommandScope`) so the frame's commands are batched and submitted once —
 * mirroring how ThinNativeEngine wraps `scene.render`.
 */
import type { GLEngineContext } from "./native-context.js";

/** Monotonic clock — `performance.now` when the host provides it, else `Date.now`. */
function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Register a per-frame callback. No-op if `fn` is already registered (matches
 * Babylon `AbstractEngine.runRenderLoop`). Starts the native frame loop on the
 * first registration. Mirrors the WebGL `runRenderLoop`.
 */
export function runRenderLoop(engine: GLEngineContext, fn: (dt: number) => void): void {
    if (engine._disposed) {
        return;
    }
    if (engine._scheduleFrame === null) {
        engine._scheduleFrame = scheduleFrame;
    }
    if (engine._loops.indexOf(fn) !== -1) {
        return;
    }
    engine._loops.push(fn);
    if (!engine._rafActive && !engine._isLost) {
        scheduleFrame(engine);
    }
}

/** Stop one (or all when omitted) registered callbacks. Mirrors the WebGL
 *  `stopRenderLoop`. Native `requestAnimationFrame` returns no id, so the loop is
 *  gated by the `_rafActive` flag + the empty callback list. */
export function stopRenderLoop(engine: GLEngineContext, fn?: (dt: number) => void): void {
    if (fn === undefined) {
        engine._loops.length = 0;
    } else {
        const i = engine._loops.indexOf(fn);
        if (i !== -1) {
            engine._loops.splice(i, 1);
        }
    }
    if (engine._loops.length === 0) {
        engine._rafActive = false;
    }
}

/**
 * Marks the start of a frame (Babylon `engine.beginFrame()`). `runRenderLoop`
 * calls this automatically before its callbacks; call it yourself only when
 * driving frames manually. A no-op unless a frame-level feature such as
 * `captureGPUFrameTime` is enabled.
 *
 * @param engine - The engine.
 */
export function beginFrame(engine: GLEngineContext): void {
    engine._frameHooks?._begin();
}

/**
 * Marks the end of a frame (Babylon `engine.endFrame()`). `runRenderLoop` calls
 * this automatically after its callbacks; pair it with `beginFrame` in manual
 * loops. A no-op unless a frame-level feature such as `captureGPUFrameTime` is
 * enabled.
 *
 * @param engine - The engine.
 */
export function endFrame(engine: GLEngineContext): void {
    engine._frameHooks?._end();
}

/** Schedule the next native frame. */
function scheduleFrame(engine: GLEngineContext): void {
    engine._prevNow = nowMs();
    engine._rafActive = true;
    engine._engine.requestAnimationFrame(() => tick(engine));
}

/** One native frame: batch the callbacks' commands in a scope, submit, reschedule. */
function tick(engine: GLEngineContext): void {
    if (engine._disposed || engine._isLost || !engine._rafActive || engine._loops.length === 0) {
        engine._rafActive = false;
        return;
    }
    const now = nowMs();
    const dt = now - engine._prevNow;
    engine._prevNow = now;

    engine._encoder.beginCommandScope();
    const loops = engine._loops.slice();
    // Inlined beginFrame / endFrame so unused exports tree-shake out. The
    // snapshot pairs begin/end on the same hooks if a callback toggles capture.
    const hooks = engine._frameHooks;
    hooks?._begin();
    for (const cb of loops) {
        try {
            cb(dt);
        } catch (err) {
            console.error("lite-gl: render loop callback threw", err);
        }
    }
    hooks?._end();
    engine._encoder.endCommandScope();

    if (engine._loops.length > 0 && !engine._disposed && !engine._isLost) {
        engine._engine.requestAnimationFrame(() => tick(engine));
    } else {
        engine._rafActive = false;
    }
}
