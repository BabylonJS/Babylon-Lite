import { type GLEngineContext } from "./context.js";

/** Register a per-frame callback. **No-op if `fn` is already registered**
 *  (matches Babylon `AbstractEngine.runRenderLoop`). Starts the rAF if this is
 *  the first registration. */
export function runRenderLoop(engine: GLEngineContext, fn: (dt: number) => void): void {
    if (engine._disposed) {
        return;
    }
    // Install the resume hook on the context (no module-level side effects).
    if (engine._scheduleFrame === null) {
        engine._scheduleFrame = scheduleFrame;
    }
    if (engine._loops.indexOf(fn) !== -1) {
        return;
    }
    engine._loops.push(fn);
    if (engine._rafId === 0 && !engine._isLost) {
        scheduleFrame(engine);
    }
}

/** Stop one (or all when omitted) registered callbacks. Cancels the rAF if
 *  no callbacks remain. */
export function stopRenderLoop(engine: GLEngineContext, fn?: (dt: number) => void): void {
    if (fn === undefined) {
        engine._loops.length = 0;
    } else {
        const i = engine._loops.indexOf(fn);
        if (i !== -1) {
            engine._loops.splice(i, 1);
        }
    }
    if (engine._loops.length === 0 && engine._rafId !== 0) {
        cancelAnimationFrame(engine._rafId);
        engine._rafId = 0;
    }
}

function scheduleFrame(engine: GLEngineContext): void {
    engine._prevNow = performance.now();
    engine._rafId = requestAnimationFrame((now) => tick(engine, now));
}

function tick(engine: GLEngineContext, now: number): void {
    engine._rafId = 0;
    if (engine._disposed || engine._isLost || engine._loops.length === 0) {
        return;
    }
    const dt = now - engine._prevNow;
    engine._prevNow = now;
    // Snapshot — a callback may call stopRenderLoop on itself or others.
    const loops = engine._loops.slice();
    for (const cb of loops) {
        try {
            cb(dt);
        } catch (err) {
            console.error("lite-gl: render loop callback threw", err);
        }
    }
    if (engine._loops.length > 0 && !engine._disposed && !engine._isLost) {
        engine._rafId = requestAnimationFrame((nextNow) => tick(engine, nextNow));
    }
}
