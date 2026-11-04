/**
 * Error thrown when Babylon.js code reaches an API surface that the Babylon Lite
 * compatibility layer cannot (or does not yet) support.
 *
 * The compat layer intentionally favours a loud, discoverable failure over a
 * silent wrong result: if a ported scene hits one of these, the porting gap is
 * surfaced immediately with a pointer to the reason and (where relevant) the
 * native Lite API to use instead.
 */
export class LiteCompatError extends Error {
    public constructor(api: string, detail?: string) {
        super(detail ? `'${api}' is not supported by the Babylon Lite compat layer. ${detail}` : `'${api}' is not supported by the Babylon Lite compat layer.`);
        this.name = "LiteCompatError";
    }
}

/** Throw a {@link LiteCompatError} for an unsupported API. */
export function unsupported(api: string, detail?: string): never {
    throw new LiteCompatError(api, detail);
}
