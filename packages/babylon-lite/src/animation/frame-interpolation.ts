import type { SceneContext } from "../scene/scene-core.js";

/** Coerce an unknown rejection reason (e.g. `AbortSignal.reason`, which is typed `any`) to an Error. */
function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

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
            const index = scene._beforeRender.indexOf(driver);
            if (index >= 0) {
                scene._beforeRender.splice(index, 1);
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
