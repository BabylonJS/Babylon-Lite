import { describe, expect, it } from "vitest";

import { decodeError } from "../../../packages/babylon-lite/src/enable-error-decoding";
import { ThrowLiteError, type LiteError } from "../../../packages/babylon-lite/src/lite-error";
import { decodeLiteError } from "../../../packages/babylon-lite/src/error-messages";

describe("decodeError", () => {
    it("stringifies non-Error inputs instead of throwing", () => {
        expect(decodeError("boom")).toBe("boom");
        expect(decodeError(42)).toBe("42");
        expect(decodeError(null)).toBe("null");
        expect(decodeError(undefined)).toBe("undefined");
        expect(decodeError({ message: "not an error" })).toBe("[object Object]");
    });

    it("returns the message unchanged for a plain Error carrying no coded args", () => {
        expect(decodeError(new Error("plain failure"))).toBe("plain failure");
    });

    it("decodes a coded `#<code>` error by routing its code and args through the message table", () => {
        // Reproduces what ThrowLiteError produces: a `#<code>` message with the raw
        // interpolation args attached on `lite`.
        const error: LiteError = new Error("#7");
        error.lite = ["shadow", 4];

        // Goes through the table (placeholder resolves to `Error #<code>`), NOT the raw `#7`.
        expect(decodeError(error)).toBe(decodeLiteError(7, error.lite));
        expect(decodeError(error)).toBe("Error #7");
        expect(decodeError(error)).not.toBe(error.message);
    });

    it("decodes an error captured from an actual ThrowLiteError throw site", () => {
        let caught: unknown;
        try {
            ThrowLiteError(5, "a", "b");
        } catch (error) {
            caught = error;
        }
        expect((caught as LiteError).message).toBe("#5");
        expect(decodeError(caught)).toBe("Error #5");
    });

    it("returns the message unchanged when `lite` is present but not a real array", () => {
        // A non-array `lite` (e.g. from user-land or structured logging) must not make the
        // telemetry-safe decodeError throw, even for a `#<code>`-shaped message.
        const error = new Error("#9") as Error & { lite: unknown };
        error.lite = 123;
        expect(decodeError(error)).toBe("#9");
    });

    it("passes through an already-decoded error (message no longer a bare code)", () => {
        // When decoding was enabled at throw time the message is the full text, so there is no
        // `#<code>` to re-read — the message is returned as-is even though `lite` is present.
        const error: LiteError = new Error("Already decoded: shadow cascade 4");
        error.lite = ["shadow", 4];
        expect(decodeError(error)).toBe("Already decoded: shadow cascade 4");
    });
});
