/**
 * Alpha-to-coverage — the Babylon Native backend of `src/alpha-to-coverage.ts`.
 *
 * DECLARED DIVERGENCE: Babylon Native's command stream exposes no
 * alpha-to-coverage state (`caps.alphaToCoverage === false`). Queries return the
 * neutral value, disabling is a safe no-op, and enabling throws.
 */
import type { GLEngineContext } from "./native-context.js";

/**
 * Enable or disable alpha-to-coverage.
 *
 * NATIVE: `false` is a no-op (the feature is never on); `true` throws.
 *
 * @param engine - The engine.
 * @param enabled - Requested state.
 * @throws When `enabled` is `true` — not supported on Babylon Native.
 */
export function setAlphaToCoverage(engine: GLEngineContext, enabled: boolean): void {
    void engine;
    if (enabled) {
        throw new Error("lite-gl: setAlphaToCoverage is not supported on Babylon Native");
    }
}

/**
 * Whether alpha-to-coverage is enabled. Always `false` on Babylon Native.
 *
 * @param engine - The engine.
 * @returns `false`.
 */
export function getAlphaToCoverage(engine: GLEngineContext): boolean {
    void engine;
    return false;
}

/**
 * The sample count of the current draw target. Babylon Native does not expose
 * the host's MSAA configuration to JS, and lite-gl render targets are created
 * single-sampled, so this is always `1`.
 *
 * @param engine - The engine.
 * @returns `1`.
 */
export function getCurrentSampleCount(engine: GLEngineContext): number {
    void engine;
    return 1;
}
