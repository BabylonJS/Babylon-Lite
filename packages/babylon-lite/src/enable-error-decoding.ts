import { _setLiteErrorDecoder, type LiteError } from "./lite-error.js";
import { decodeLiteError } from "./error-messages.js";

/** Opt in to full, human-readable error messages.
 *
 *  To keep shipped bundles small, Babylon-Lite throws errors carrying a numeric code plus the
 *  values the message would have interpolated; the verbose message text lives in a separate
 *  chunk that is NOT loaded by default. Calling this once (e.g. in development, or in a global
 *  error handler) installs a decoder, so every error thrown afterwards — caught or uncaught —
 *  reports its full message via `error.message`.
 *
 *  Importing this module pulls in the message table chunk (calling the function only installs the
 *  decoder); avoid *statically* importing it into production bundles you want to stay lean. A
 *  global error handler can still `import()` it lazily when it needs full messages. */
export function enableErrorDecoding(): void {
    _setLiteErrorDecoder(decodeLiteError);
}

/** Decode a Babylon-Lite error into its full, human-readable message.
 *
 *  Accepts `unknown` so you can hand it a `catch` binding directly (which TypeScript types as
 *  `unknown`) with no cast. Works even when {@link enableErrorDecoding} was never called: by default
 *  Babylon-Lite throws errors whose message is the bare code `#<code>` with the interpolation args
 *  attached as a `lite` property, so this reads the code and args back out and runs them through the
 *  message table. If the error was already decoded (decoding was enabled when it was thrown) or isn't
 *  a Babylon-Lite coded error, its message is returned unchanged (non-`Error` values are stringified).
 *
 *  Importing this module pulls in the message table chunk (same as {@link enableErrorDecoding}), so
 *  avoid *statically* importing it into lean production bundles; the intended production pattern is
 *  to `import()` it lazily from a `catch`/telemetry path only when an error actually fires. */
export function decodeError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    // `lite` is arbitrary on an `unknown` error; require a real array before spreading it through
    // the table so decodeError stays safe to call from telemetry paths (covers undefined too).
    const args = (error as LiteError).lite;
    if (!Array.isArray(args)) {
        return error.message;
    }
    const match = /^#(\d+)$/.exec(error.message);
    return match ? decodeLiteError(Number(match[1]), args) : error.message;
}
