import { _setLiteErrorDecoder } from "./lite-error.js";
import { decodeLiteError } from "./error-messages.js";

/** Opt in to full, human-readable error messages.
 *
 *  To keep shipped bundles small, Babylon-Lite throws errors carrying a numeric code plus the
 *  values the message would have interpolated; the verbose message text lives in a separate
 *  chunk that is NOT loaded by default. Calling this once (e.g. in development, or in a global
 *  error handler) loads that table and installs a decoder, so every error thrown afterwards —
 *  caught or uncaught — reports its full message via `error.message`.
 *
 *  This pulls in the message table chunk; leave it out of production builds to keep them lean. */
export function enableErrorDecoding(): void {
    _setLiteErrorDecoder(decodeLiteError);
}
