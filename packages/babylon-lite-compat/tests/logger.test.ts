import { describe, expect, it } from "vitest";

import { Logger, PrecisionDate } from "../src/misc/misc-utils";

describe("Logger", () => {
    it("exposes level constants", () => {
        expect(Logger.MessageLogLevel).toBe(1);
        expect(Logger.WarningLogLevel).toBe(2);
        expect(Logger.ErrorLogLevel).toBe(4);
        expect(Logger.AllLogLevel).toBe(7);
    });
});

describe("PrecisionDate", () => {
    it("returns a monotonic-ish timestamp", () => {
        const a = PrecisionDate.Now;
        const b = PrecisionDate.Now;
        expect(typeof a).toBe("number");
        expect(b).toBeGreaterThanOrEqual(a);
    });
});
