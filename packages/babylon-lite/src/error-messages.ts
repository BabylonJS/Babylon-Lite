/** Babylon-Lite error message table.
 *
 *  This placeholder is REPLACED at build time by `scripts/lite-error-plugin.ts`, which emits the
 *  generated `code → message` lookup gathered from every rewritten `throw new Error(...)` site.
 *  The placeholder below is what a raw-source (un-plugged) consumer sees: it degrades gracefully
 *  to the generic coded message. Either way, `decodeLiteError` returns a string for a given code
 *  and the runtime values (`args`) the original message interpolated. */

/** @internal Resolve the full message for `code`, applying interpolated `args`. */
export function decodeLiteError(code: number, _args: readonly unknown[]): string {
    return `Error #${code}`;
}
