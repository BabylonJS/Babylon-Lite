import { offContextLost, onContextLost, type GLEngineContext } from "./context.js";
import { getEffectCompilationError, type GLEffect } from "./effect.js";

/** Options for the opt-in `waitForEffect` readiness scheduler. */
export interface GLEffectWaitOptions {
    /** Cancels only this wait. Error reasons are preserved; other reasons are
     *  the cause of a native AbortError DOMException. Does not dispose or cancel the effect. */
    signal?: AbortSignal;
}

/** Wait for readiness without starting a render loop. Polls immediately and
 *  then once per animation frame; resolves with the finalized effect.
 *  Rejects on compile/link/restore failure, context loss, disposal (observed
 *  on the next poll), or signal cancellation. All exits cancel the pending
 *  frame and remove listeners. Call again after context restoration to wait
 *  for the replacement program. Scheduling code is tree-shaken when unused.
 *  @param engine - Engine owning the effect.
 *  @param effect - Effect to finalize.
 *  @param options - Optional cancellation signal.
 *  @returns The ready effect, or a rejected promise with the failure reason.
 */
export function waitForEffect(engine: GLEngineContext, effect: GLEffect, options?: GLEffectWaitOptions): Promise<GLEffect> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal;
        let frame: number | null = null;
        let settled = false;

        const cleanup = (): void => {
            settled = true;
            if (frame !== null) {
                cancelAnimationFrame(frame);
                frame = null;
            }
            offContextLost(engine, lost);
            signal?.removeEventListener("abort", abort);
        };
        const fail = (error: Error): void => {
            if (settled) {
                return;
            }
            cleanup();
            reject(error);
        };
        const lost = (): void => fail(new Error(`lite-gl: ${effect.name} context lost while waiting for compilation`));
        const abort = (): void => {
            const reason: unknown = signal?.reason;
            if (reason instanceof Error) {
                fail(reason);
            } else {
                fail(Object.assign(new DOMException(`lite-gl: ${effect.name} compilation wait aborted`, "AbortError"), { cause: reason }));
            }
        };
        const poll = (): void => {
            frame = null;
            if (settled) {
                return;
            }
            try {
                // Registering an abort listener does not replay a prior abort.
                if (signal?.aborted) {
                    abort();
                    return;
                }
                // Disposal has no callback; these guards also cover already-disposed/lost inputs.
                if (engine._disposed || effect._disposed) {
                    fail(new Error(`lite-gl: ${effect.name} disposed while waiting for compilation`));
                    return;
                }
                if (engine._isLost) {
                    lost();
                    return;
                }
                const error = getEffectCompilationError(engine, effect);
                // Abort/loss callbacks set settled synchronously during finalization.
                if (settled) {
                    return;
                }
                // Finalization callbacks can dispose without any notification.
                if (engine._disposed || effect._disposed) {
                    fail(new Error(`lite-gl: ${effect.name} disposed while waiting for compilation`));
                } else if (error !== null) {
                    fail(new Error(`lite-gl: ${effect.name} ${error}`));
                } else if (effect.isReady) {
                    cleanup();
                    resolve(effect);
                } else {
                    frame = requestAnimationFrame(poll);
                }
            } catch (error) {
                fail(error instanceof Error ? error : new Error(`lite-gl: ${effect.name} compilation wait failed`, { cause: error }));
            }
        };

        onContextLost(engine, lost);
        signal?.addEventListener("abort", abort, { once: true });
        poll();
    });
}
