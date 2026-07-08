import type { SceneContext } from "../scene/scene-core.js";

/** Coerce an unknown rejection reason (e.g. `AbortSignal.reason`, which is typed `any`) to an Error. */
function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Shared sentinel used to retire a finished driver in place. `scene._beforeRender` is walked with a
 * live `for...of` loop each frame, so a finished driver must not change the array length mid-frame
 * (that would skip the next callback). It swaps itself for this noop instead; trailing noops are then
 * trimmed so the array cannot grow without bound.
 */
const RetiredDriver = (): void => {};

/**
 * Per-frame update callback driven by {@link runFrameInterpolation}. Called once
 * per rendered frame with the frame's delta time in seconds.
 * @param deltaSeconds - Elapsed time since the previous frame, in seconds.
 * @returns `true` to keep interpolating next frame, or `false` when the goal has
 *   been reached (natural completion). To cancel the interpolation, throw — the
 *   thrown value becomes the returned promise's rejection reason.
 */
export type FrameInterpolationStep = (deltaSeconds: number) => boolean;

/**
 * Drive a per-frame interpolation from a scene's render loop until it completes,
 * is canceled via the abort signal, or the step throws. This owns the
 * `scene._beforeRender` registration and guarantees the callback is detached on
 * every exit path (completion, cancellation, or error). It is entity-agnostic —
 * it knows nothing about cameras or transforms.
 * @param scene - The scene whose render loop advances the interpolation.
 * @param step - The per-frame update. Return `false` to finish; throw to cancel.
 * @param signal - Optional abort signal. When it aborts, the loop is detached and
 *   the returned promise rejects with the signal's reason. If it is already
 *   aborted, `step` never runs.
 * @returns A promise that resolves when `step` returns `false` (completed) and
 *   rejects if `step` throws or the signal aborts.
 */
export function runFrameInterpolation(scene: SceneContext, step: FrameInterpolationStep, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(toError(signal.reason));
            return;
        }

        let settled = false;
        let onAbort: (() => void) | undefined;

        // Detach the driver and stop listening for aborts. Idempotent via the
        // `settled` guard so completion, cancellation, and abort can't double-act.
        const finish = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            const list = scene._beforeRender;
            const index = list.indexOf(driver);
            if (index >= 0) {
                // Do NOT splice: scene-core walks `_beforeRender` with a live for-of, so shrinking the
                // array mid-frame (finish() can run from inside `driver` during that walk) would skip
                // the next callback — e.g. another active interpolation. Retire the slot in place, then
                // trim any trailing retired slots so the array can't grow without bound.
                list[index] = RetiredDriver;
                while (list.length > 0 && list[list.length - 1] === RetiredDriver) {
                    list.pop();
                }
            }
            if (onAbort && signal) {
                signal.removeEventListener("abort", onAbort);
            }
        };

        const driver = (deltaMs: number): void => {
            if (settled) {
                return;
            }
            // Fall back to a nominal 60 FPS step when the render loop reports a
            // non-positive delta, so the interpolation always makes progress.
            const deltaSeconds = (deltaMs > 0 ? deltaMs : 1000 / 60) / 1000;
            let shouldContinue: boolean;
            try {
                shouldContinue = step(deltaSeconds);
            } catch (error) {
                finish();
                reject(toError(error));
                return;
            }
            if (!shouldContinue) {
                finish();
                resolve();
            }
        };

        if (signal) {
            onAbort = (): void => {
                finish();
                reject(toError(signal.reason));
            };
            signal.addEventListener("abort", onAbort);
        }

        scene._beforeRender.push(driver);
    });
}
