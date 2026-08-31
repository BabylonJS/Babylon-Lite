import { describe, expect, it } from "vitest";
import {
    computeSceneHeadroom,
    CRITICAL_HEADROOM_BYTES,
    formatHeadroomThreshold,
    HEADROOM_LIST_LIMIT,
    measuredBytesOf,
    scenesUnderHeadroom,
    TIGHT_HEADROOM_BYTES,
    type SceneHeadroomInput,
} from "../../../scripts/bundle-ceiling-headroom";

describe("bundle ceiling headroom", () => {
    it("keeps the tight band at one kilobyte with the old value as the inner band", () => {
        // The 1 KB band is the point below which the PR delta table (whole KB) cannot show the
        // risk at all; 256 B is retained as "critical" rather than deleted. Both are warning
        // thresholds only — nothing here fails a build.
        expect(TIGHT_HEADROOM_BYTES).toBe(1024);
        expect(CRITICAL_HEADROOM_BYTES).toBe(256);
        expect(CRITICAL_HEADROOM_BYTES).toBeLessThan(TIGHT_HEADROOM_BYTES);
        expect(HEADROOM_LIST_LIMIT).toBeGreaterThan(0);
    });

    it("prefers exact bytes and falls back to the rounded KB size", () => {
        expect(measuredBytesOf({ rawKB: 88.7, rawBytes: 90780 })).toBe(90780);
        expect(measuredBytesOf({ rawKB: 2 })).toBe(2048);
        expect(measuredBytesOf({})).toBeNull();
        expect(measuredBytesOf(undefined)).toBeNull();
    });

    it("separates over-ceiling scenes from those with headroom, tightest first", () => {
        const inputs: SceneHeadroomInput[] = [
            { scene: "scene1", measuredBytes: 1024, ceilingKB: 2 },
            { scene: "scene2", measuredBytes: 2000, ceilingKB: 2 },
            { scene: "scene3", measuredBytes: 3000, ceilingKB: 2 },
            { scene: "scene4", measuredBytes: 5000, ceilingKB: 2 },
        ];

        const { over, under } = computeSceneHeadroom(inputs);

        expect(under.map((s) => s.scene)).toEqual(["scene2", "scene1"]);
        expect(under.map((s) => s.headroomBytes)).toEqual([48, 1024]);
        expect(over.map((s) => s.scene)).toEqual(["scene4", "scene3"]);
        expect(over.map((s) => s.headroomBytes)).toEqual([2952, 952]);
    });

    it("compares before rounding so a fractional ceiling cannot wave an overflow through", () => {
        // 92.2 KB is 94412.8 bytes: 94413 is over by 0.2, which Math.round would turn into -0.
        const { over, under } = computeSceneHeadroom([
            { scene: "scene5", measuredBytes: 94413, ceilingKB: 92.2 },
            { scene: "scene6", measuredBytes: 94412, ceilingKB: 92.2 },
        ]);

        expect(over.map((s) => s.scene)).toEqual(["scene5"]);
        expect(over[0]!.headroomBytes).toBe(1);
        expect(under.map((s) => s.scene)).toEqual(["scene6"]);
        expect(under[0]!.headroomBytes).toBe(0);
    });

    it("selects scenes strictly below a threshold", () => {
        const { under } = computeSceneHeadroom([
            { scene: "critical", measuredBytes: 2048 - 100, ceilingKB: 2 },
            { scene: "exactly-critical", measuredBytes: 2048 - CRITICAL_HEADROOM_BYTES, ceilingKB: 2 },
            { scene: "tight", measuredBytes: 2048 - 900, ceilingKB: 2 },
            { scene: "roomy", measuredBytes: 0, ceilingKB: 2 },
        ]);

        expect(scenesUnderHeadroom(under, CRITICAL_HEADROOM_BYTES).map((s) => s.scene)).toEqual(["critical"]);
        expect(scenesUnderHeadroom(under, TIGHT_HEADROOM_BYTES).map((s) => s.scene)).toEqual(["critical", "exactly-critical", "tight"]);
    });

    it("names thresholds the way the reports print them", () => {
        expect(formatHeadroomThreshold(TIGHT_HEADROOM_BYTES)).toBe("1.0 KB");
        expect(formatHeadroomThreshold(CRITICAL_HEADROOM_BYTES)).toBe("256 B");
    });
});
