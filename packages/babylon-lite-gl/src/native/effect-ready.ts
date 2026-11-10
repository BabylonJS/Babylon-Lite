/**
 * Opt-in effect readiness scheduler — the Babylon Native backend of
 * `src/effect-ready.ts`. Same contract as the WebGL module; the only difference
 * is scheduling: polls run on the native engine's `requestAnimationFrame`
 * (which has no cancel, so a settled flag retires a pending poll), falling back
 * to `setTimeout` when the host lacks it.
 */
import { offContextLost, onContextLost } from "./native-context.js";
import { getEffectCompilationError, type GLEffect } from "./effect.js";
import type { GLEffectWaitOptions } from "../effect-ready.js";

export type { GLEffectWaitOptions } from "../effect-ready.js";

/** Build the AbortError rejection. Babylon Native hosts may lack `DOMException`,
 *  so fall back to a plain `Error` named `AbortError`. */
function abortError(message: string, cause: unknown): Error {
    if (typeof DOMException === "function") {
        return Object.assign(new DOMException(message, "AbortError"), { cause });
    }
    return Object.assign(new Error(message, { cause }), { name: "AbortError" });
}

/**
 * Wait for readiness without starting a render loop. Polls immediately and then
 * once per native frame; resolves with the finalized effect. Rejects on
 * compile/link failure, context loss, disposal (observed on the next poll), or
 * signal cancellation. All exits remove the listeners. Call again after a device
 * restore to wait for the replacement program.
 *
 * @param effect - Effect to finalize.
 * @param options - Optional cancellation signal.
 * @returns The ready effect, or a rejected promise with the failure reason.
 */
export function waitForEffect(effect: GLEffect, options?: GLEffectWaitOptions): Promise<GLEffect> {
    const engine = effect._engine;
    return new Promise((resolve, reject) => {
        const signal = options?.signal;
        let settled = false;

        const cleanup = (): void => {
            settled = true;
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
                fail(abortError(`lite-gl: ${effect.name} compilation wait aborted`, reason));
            }
        };
        const schedule = (): void => {
            const native = engine._engine;
            if (typeof native.requestAnimationFrame === "function") {
                native.requestAnimationFrame(poll);
            } else {
                setTimeout(poll, 16);
            }
        };
        const poll = (): void => {
            if (settled) {
                return;
            }
            try {
                if (signal?.aborted) {
                    abort();
                    return;
                }
                if (engine._disposed || effect._disposed) {
                    fail(new Error(`lite-gl: ${effect.name} disposed while waiting for compilation`));
                    return;
                }
                if (engine._isLost) {
                    lost();
                    return;
                }
                const error = getEffectCompilationError(effect);
                if (settled) {
                    return;
                }
                if (engine._disposed || effect._disposed) {
                    fail(new Error(`lite-gl: ${effect.name} disposed while waiting for compilation`));
                } else if (error !== null) {
                    fail(new Error(`lite-gl: ${effect.name} ${error}`));
                } else if (effect.isReady) {
                    cleanup();
                    resolve(effect);
                } else {
                    schedule();
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
