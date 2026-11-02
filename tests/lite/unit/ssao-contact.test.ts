import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adaptContactDemo, contactViolations, parseContactOptions, summarizeContact, summarizeContactTrail } from "../../../scripts/ao-reference/contact-contract.js";
import type { ContactFrame } from "../../../scripts/ao-reference/contact-contract.js";

function frames(signal: (frame: number, point: number) => number): ContactFrame[] {
    return Array.from({ length: 32 }, (_, f) => ({
        actual: Array.from({ length: 16 }, (_, p) => signal(f, p)),
        spatial: Array.from({ length: 16 }, (_, p) => 0.8 + (f % 2 ? 0.04 : -0.04) * (p % 2 ? 1 : -1)),
    }));
}

describe("localized contact-shadow regression", () => {
    it("does not mistake constant or smoothly changing visibility for shimmer", () => {
        expect(contactViolations(summarizeContact(frames(() => 0.8)))).toEqual([]);
        const linear = summarizeContact(frames((f) => 0.7 + f * 0.001));
        expect(linear.temporalSecondDifferenceRms).toBeLessThan(1e-14);
        expect(contactViolations(linear)).toEqual([]);
    });
    it("detects per-point shimmer even when the patch average cancels perfectly", () => {
        const metric = summarizeContact(frames((f, p) => 0.8 + (f % 2 ? 0.003 : -0.003) * (p % 2 ? 1 : -1)));
        expect(metric.temporalSecondDifferenceRms).toBeCloseTo(0.012, 12);
        expect(metric.patchSecondDifferenceRms).toBeLessThan(1e-14);
        expect(contactViolations(metric).length).toBe(2);
    });
    it("detects coherent patch fluctuation below the per-point quantization bound", () => {
        const metric = summarizeContact(frames((f) => 0.8 + (f % 2 ? 0.0002 : -0.0002)));
        expect(metric.temporalSecondDifferenceRms).toBeLessThan(1 / 255);
        expect(contactViolations(metric)).toEqual([expect.stringContaining("patchSecondDifferenceRms")]);
    });
    it("detects a noisy contact tail without averaging it into the rest of the patch", () => {
        const metric = summarizeContact(frames((f, p) => 0.8 + (p === 0 ? (f % 2 ? 0.002 : -0.002) : 0)));
        expect(metric.temporalSecondDifferenceRms).toBeLessThan(1 / 255);
        expect(contactViolations(metric)).toContainEqual(expect.stringContaining("p95PointSecondDifferenceRms"));
    });
    it("rejects incomplete or nonfinite receiver data instead of reporting zero noise", () => {
        const missing = frames(() => 0.8);
        for (const frame of missing) for (let p = 0; p < 9; p++) frame.actual[p] = frame.spatial[p] = null;
        expect(() => summarizeContact(missing)).toThrow("coverage");
        const bad = frames(() => 0.8);
        bad[0]!.actual[0] = NaN;
        expect(() => summarizeContact(bad)).toThrow("invalid visibility");
        expect(() => summarizeContact(bad.slice(0, 3))).toThrow("24");
        const shape = frames(() => 0.8);
        shape[1]!.actual.pop();
        expect(() => summarizeContact(shape)).toThrow("dimensions");
    });
    it("accepts retained Half/Ultra and rejects the retired Quarter/Ultra numerical contact results", () => {
        const base = summarizeContact(frames(() => 0.8));
        const retained = {
            ...base,
            temporalSecondDifferenceRms: 0.0030502430642644334,
            p95PointSecondDifferenceRms: 0.004715047317199201,
            patchSecondDifferenceRms: 0.00020186785828695333,
        };
        const retired = {
            ...base,
            temporalSecondDifferenceRms: 0.005105781514029875,
            p95PointSecondDifferenceRms: 0.009348431179427684,
            patchSecondDifferenceRms: 0.0007582744136097957,
        };
        expect(contactViolations(retained)).toEqual([]);
        expect(contactViolations(retired)).toHaveLength(3);
    });
    it("does not let frozen stale shadows pass merely because they have zero second differences", () => {
        expect(contactViolations(summarizeContact(frames(() => 0.5)))).toEqual([]);
        const mean = Array(32).fill(0.9) as number[],
            old = Array(32).fill(0.5) as number[];
        const trail = summarizeContactTrail(old, mean, { actual: old, spatial: mean });
        expect(trail.samples).toBe(32);
        expect(trail.excessTrail).toBeGreaterThan(0.015);
        expect(trail.temporalTrail).toBeCloseTo(0.4);
    });
    it("subtracts instantaneous spatial undersampling from positive temporal trailing", () => {
        const mean = Array(32).fill(0.9) as number[],
            old = Array(32).fill(0.5) as number[],
            raw = Array(32).fill(0.85) as number[];
        const trail = summarizeContactTrail(old, mean, { actual: raw, spatial: raw });
        expect(trail.excessTrail).toBe(0);
        expect(trail.spatialTrail).toBeCloseTo(0.05);
        expect(() => summarizeContactTrail(mean, mean, { actual: raw, spatial: raw })).toThrow("newly lit");
        expect(() => summarizeContactTrail([], mean, { actual: raw, spatial: raw })).toThrow("dimensions");
    });
    it("uses a unique test-only hook, keeping normal rendering unchanged", async () => {
        const source = await readFile(resolve("lab/lite/src/demos/ambient-occlusion.ts"), "utf8");
        expect(adaptContactDemo(source)).toContain("exposeContactValidation(engine, ao, temporal, camera, sphere);");
        expect(adaptContactDemo(source)).not.toContain("await loadEnvironment(");
        expect(source).not.toContain("exposeContactValidation");
        expect(() => adaptContactDemo(source + "\n    await startEngine(engine);")).toThrow("exactly once");
    });
    it("requires explicit software selection and rejects unknown options", () => {
        expect(parseContactOptions([])).toEqual({ software: false });
        expect(parseContactOptions(["--software"])).toEqual({ software: true });
        expect(() => parseContactOptions(["--quarter"])).toThrow();
        expect(() => parseContactOptions(["--software", "--software"])).toThrow();
    });
});
