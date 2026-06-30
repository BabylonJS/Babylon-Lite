/** Late-bound error message decoding.
 *
 *  The browser/library build rewrites developer-facing `throw new Error("…")` call sites to
 *  `ThrowLiteError(code, …interpArgs)` (see `scripts/lite-error-plugin.ts`), moving the verbose
 *  message text out of every shipped bundle into a separate `code → message` table that is only
 *  loaded when the app opts in via {@link enableErrorDecoding}.
 *
 *  Until then a thrown error still self-describes with its numeric code. Decoding happens at
 *  construction time, so BOTH caught (`err.message`) and uncaught (console output) errors carry
 *  the decoded text once decoding is enabled.
 *
 *  Boilerplate is deliberately minimal: the decoder slot defaults to `null` and the generic
 *  message is an inline fallback (not a default closure). When an app never calls
 *  `enableErrorDecoding`, the bundler proves `_decode` is always `null`, drops the setter, and
 *  folds each rewritten throw to a bare `throw new Error(`Babylon-Lite error #<code>`)` — no
 *  decoder closure, no IIFE. No module-level side effects. */

let _decode: ((code: number, args: readonly unknown[]) => string) | null = null;

/** @internal Install the table-backed decoder. Called by {@link enableErrorDecoding}. */
export function _setLiteErrorDecoder(decode: (code: number, args: readonly unknown[]) => string): void {
    _decode = decode;
}

/** @internal Throw a Babylon-Lite error identified by `code`, passing the runtime values the
 *  original message interpolated as `args`. Returns `never` so call sites need no `throw`. */
export function ThrowLiteError(code: number, ...args: readonly unknown[]): never {
    throw new Error(_decode?.(code, args) ?? `Babylon-Lite error #${code}`);
}
