/** Late-bound error message decoding.
 *
 *  The browser/library build rewrites developer-facing `throw new Error("…")` call sites to
 *  `ThrowLiteError(code, …interpArgs)` (see `scripts/lite-error-plugin.ts`), moving the verbose
 *  message text out of every shipped bundle into a separate `code → message` table that is only
 *  loaded when the app opts in — by referencing either {@link enableErrorDecoding} (global decoder)
 *  or {@link decodeError} (on-demand, single caught error); importing either pulls in the table.
 *
 *  Until then a thrown error still self-describes: its message is `#<code>` (e.g. `#12`) and the
 *  runtime values the message would have interpolated are attached to the Error as a `lite`
 *  property. This lets the public {@link decodeError} reconstruct the full message on demand from a
 *  caught error even when decoding was never enabled globally — it reads the code back out of the
 *  `#<code>` message and the args off the object, then runs them through the real message table.
 *  Attaching the raw args (instead of serializing them into the message) keeps every scene bundle
 *  smaller, preserves full fidelity, and guarantees error construction can never itself throw.
 *  Decoding also happens at construction time when enabled, so BOTH caught (`err.message`) and
 *  uncaught (console output) errors carry the decoded text once `enableErrorDecoding` has run.
 *
 *  Boilerplate is deliberately minimal: the decoder slot defaults to `null` and the generic
 *  message is an inline fallback (not a default closure). When an app never calls
 *  `enableErrorDecoding`, the bundler proves `_decode` is always `null`, drops the setter, and
 *  folds each rewritten throw to `const e = new Error(`#<code>`); e.lite = args; throw e` — no
 *  decoder closure, no IIFE. No module-level side effects. */

let _decode: ((code: number, args: readonly unknown[]) => string) | null = null;

/** @internal An Error thrown by {@link ThrowLiteError}. Its message is `#<code>` (or the fully
 *  decoded text once decoding is enabled) and `lite` holds the raw interpolation args, so
 *  {@link decodeError} can reconstruct the full message from a caught instance on demand. */
export interface LiteError extends Error {
    lite?: readonly unknown[];
}

/** @internal Install the table-backed decoder. Called by {@link enableErrorDecoding}. */
export function _setLiteErrorDecoder(decode: (code: number, args: readonly unknown[]) => string): void {
    _decode = decode;
}

/** @internal Throw a Babylon-Lite error identified by `code`, passing the runtime values the
 *  original message interpolated as `args`. Returns `never` so call sites need no `throw`. */
export function ThrowLiteError(code: number, ...args: readonly unknown[]): never {
    const error: LiteError = new Error(_decode?.(code, args) ?? `#${code}`);
    error.lite = args;
    throw error;
}
