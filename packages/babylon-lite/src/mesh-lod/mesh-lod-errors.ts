/** MeshLoD error model — stable machine-readable codes with contextual fields.
 *
 *  Every MeshLoD failure is reported as a {@link MeshLoDError}: an ordinary `Error`
 *  carrying a stable {@link MeshLoDErrorCode} plus optional context (source URL,
 *  section type, page id, byte offset, expected/actual). Codes are part of the v1
 *  contract and never change, so applications can branch on them without parsing
 *  message text. The whole MeshLoD feature is opt-in and tree-shaken away for
 *  scenes that never import it, so these strings ship only when MeshLoD is used.
 *
 *  Errors are constructed through {@link createMeshLoDError} (never a raw Error
 *  string literal) so the developer-error-stripping build plugin does not fold the
 *  dynamic message into the shared code table. */

/** Stable v1 MeshLoD error codes. */
export type MeshLoDErrorCode =
    | "MLOD_INVALID_OPTION"
    | "MLOD_ABORTED"
    | "MLOD_DISPOSED"
    | "MLOD_HTTP_STATUS"
    | "MLOD_HTTP_RANGE"
    | "MLOD_HTTP_ENCODING"
    | "MLOD_TRUNCATED"
    | "MLOD_BAD_MAGIC"
    | "MLOD_UNSUPPORTED_VERSION"
    | "MLOD_UNSUPPORTED_ENDIAN"
    | "MLOD_HEADER_INTEGRITY"
    | "MLOD_DIRECTORY_INTEGRITY"
    | "MLOD_SECTION_INTEGRITY"
    | "MLOD_PAGE_INTEGRITY"
    | "MLOD_INVALID_LAYOUT"
    | "MLOD_INVALID_HIERARCHY"
    | "MLOD_BUDGET_TOO_SMALL"
    | "MLOD_UNSUPPORTED_MATERIAL"
    | "MLOD_DECODER_LOAD"
    | "MLOD_DECODER_FAILURE"
    | "MLOD_DEVICE_LIMIT"
    | "MLOD_DEVICE_RECOVERY";

/** A MeshLoD error. It is always an `Error` instance, so ordinary `try/catch`
 *  and `instanceof Error` work; {@link isMeshLoDError} narrows to this shape. */
export interface MeshLoDError extends Error {
    readonly code: MeshLoDErrorCode;
    /** Source URL for range/protocol failures. */
    readonly url?: string;
    /** `.mlod` section type for section/integrity failures. */
    readonly sectionType?: number;
    /** Page id for page-level failures. */
    readonly pageId?: number;
    /** Absolute file byte offset the failure was detected at. */
    readonly byteOffset?: number;
    /** Expected value (magic, version, length, range) for diagnostics. */
    readonly expected?: string | number;
    /** Actual value observed for diagnostics. */
    readonly actual?: string | number;
    /** Underlying cause when the failure wraps another error. */
    readonly cause?: unknown;
}

/** Optional contextual fields attached to a {@link MeshLoDError}. */
export interface MeshLoDErrorContext {
    url?: string;
    sectionType?: number;
    pageId?: number;
    byteOffset?: number;
    expected?: string | number;
    actual?: string | number;
    cause?: unknown;
}

/** @internal Writable view used only while constructing an error. */
type MeshLoDErrorMutable = {
    -readonly [K in keyof MeshLoDError]: MeshLoDError[K];
};

/** Construct a {@link MeshLoDError} with a stable code and optional context.
 *  The `message` argument is a runtime value (not a string literal), so the
 *  error-string build plugin leaves it in place. */
export function createMeshLoDError(code: MeshLoDErrorCode, message: string, context?: MeshLoDErrorContext): MeshLoDError {
    const error = new Error(message) as MeshLoDErrorMutable;
    error.name = "MeshLoDError";
    error.code = code;
    if (context) {
        Object.assign(error, context);
    }
    return error;
}

/** Type guard for {@link MeshLoDError}. True for any `Error` carrying an
 *  `MLOD_`-prefixed string `code`. */
export function isMeshLoDError(error: unknown): error is MeshLoDError {
    return error instanceof Error && typeof (error as Partial<MeshLoDError>).code === "string" && (error as MeshLoDError).code.startsWith("MLOD_");
}
