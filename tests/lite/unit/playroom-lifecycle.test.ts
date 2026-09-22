import { describe, expect, it } from "vitest";
import { liveCount, summarizeSamples } from "../../../lab/lite/src/tests/playroom-lifecycle-metrics.js";

describe("Playroom lifecycle diagnostics", () => {
    it("summarizes bounded timing samples without timing pass/fail thresholds", () => {
        expect(summarizeSamples([])).toEqual({ count: 0, minimum: 0, median: 0, p95: 0, maximum: 0, mean: 0 });
        expect(summarizeSamples([40, 10, 30, 20, 50])).toEqual({
            count: 5,
            minimum: 10,
            median: 30,
            p95: 40,
            maximum: 50,
            mean: 30,
        });
    });

    it("reports native lifetime as creation minus release", () => {
        expect(liveCount(1970, 0)).toBe(1970);
        expect(liveCount(7880, 5910)).toBe(1970);
    });
});
