import { describe, expect, it } from "vitest";
import { classifySplatLodOutcome, countSplatLodTargetDisplayGaps, waitForSplatLodDeadline } from "../../../scripts/splat-lod-comparison-outcome";
import type { SplatLodLeafRecord } from "../../../scripts/splat-lod-comparison-types";

function leaf(overrides: Partial<SplatLodLeafRecord> = {}): SplatLodLeafRecord {
    return {
        id: "tree",
        index: 0,
        visible: true,
        nativeVisible: true,
        distance: 1,
        targetLod: 0,
        requestedLod: 0,
        displayedLod: 0,
        resolvedLods: [0],
        targetCount: 1,
        displayedCount: 1,
        targetSourceState: "resident",
        residentLods: [0],
        gap: 0,
        ...overrides,
    };
}

describe("splat LOD comparison outcomes", () => {
    it("never reports convergence when an error exists despite zero gaps", () => {
        expect(
            classifySplatLodOutcome({
                timedOut: false,
                quiet: true,
                ready: true,
                pressure: false,
                error: "device lost",
                queuedFiles: 0,
                pendingRequests: 0,
                gapLeaves: 0,
            })
        ).toBe("failed");
    });

    it("counts a positive target with no displayed representation as a gap", () => {
        expect(countSplatLodTargetDisplayGaps([leaf({ displayedLod: null, resolvedLods: [], displayedCount: null, gap: null })])).toBe(1);
    });

    it("requires conclusive readiness and zero pending work", () => {
        expect(
            classifySplatLodOutcome({
                timedOut: false,
                quiet: true,
                ready: true,
                pressure: false,
                error: null,
                queuedFiles: 0,
                pendingRequests: 1,
                gapLeaves: 0,
            })
        ).toBe("sampling");
    });

    it("propagates initialization failures and bounds initialization waits", async () => {
        await expect(waitForSplatLodDeadline(Promise.reject(new Error("init failed")), performance.now() + 100, "initialization")).rejects.toThrow("init failed");
        await expect(waitForSplatLodDeadline(new Promise(() => {}), performance.now() + 5, "initialization")).rejects.toThrow("initialization timed out");
    });

    it("disposes an initialization result that arrives after its deadline", async () => {
        let resolve!: (value: object) => void;
        const pending = new Promise<object>((complete) => (resolve = complete));
        const disposed: object[] = [];
        await expect(waitForSplatLodDeadline(pending, performance.now() + 5, "initialization", (value) => disposed.push(value))).rejects.toThrow("timed out");
        const late = {};
        resolve(late);
        await Promise.resolve();
        expect(disposed).toEqual([late]);
    });
});
