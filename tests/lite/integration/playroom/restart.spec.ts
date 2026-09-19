import { expect, test } from "@playwright/test";
import { lifecycleCommand, openLifecycleHarness } from "./fixtures.js";
import type { DisposeWorkloadReport, RestartCheckpoint, RestartWorkloadReport } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

const POSITION_ABSOLUTE_TOLERANCE = 1e-5;
const POSITION_RELATIVE_TOLERANCE = 1e-6;

function expectVectorClose(actual: readonly number[], expected: readonly number[]): void {
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) {
        const tolerance = POSITION_ABSOLUTE_TOLERANCE + POSITION_RELATIVE_TOLERANCE * Math.abs(expected[index]!);
        expect(Math.abs(actual[index]! - expected[index]!)).toBeLessThanOrEqual(tolerance);
    }
}

function expectQuaternionEquivalent(actual: readonly number[], expected: readonly number[]): void {
    const direct = Math.hypot(...actual.map((value, index) => value - expected[index]!));
    const negated = Math.hypot(...actual.map((value, index) => value + expected[index]!));
    expect(Math.min(direct, negated)).toBeLessThanOrEqual(POSITION_ABSOLUTE_TOLERANCE);
}

function expectCurrentCpuNativeAgreement(checkpoint: RestartCheckpoint): void {
    for (const sample of checkpoint.placement.samples) {
        expectVectorClose(sample.nativePosition, sample.cpuWorldPosition);
        expectQuaternionEquivalent(sample.nativeRotation, sample.cpuWorldRotation);
    }
    expect(checkpoint.placement.gpuHashes).toEqual(checkpoint.placement.matrixHashes);
}

function expectRestarted(checkpoint: RestartCheckpoint, authored: RestartWorkloadReport["authored"], baseline: RestartCheckpoint): void {
    expect(checkpoint.identity).toEqual(baseline.identity);
    expect(checkpoint.resources).toEqual(baseline.resources);
    expect(checkpoint.placement.matrixHashes).toEqual(authored.matrixHashes);
    expect(checkpoint.placement.samples.map((sample) => sample.cpu)).toEqual(authored.samples.map((sample) => sample.cpu));
    for (let index = 0; index < authored.samples.length; index++) {
        expectVectorClose(checkpoint.placement.samples[index]!.nativePosition, authored.samples[index]!.nativePosition);
        expectQuaternionEquivalent(checkpoint.placement.samples[index]!.nativeRotation, authored.samples[index]!.nativeRotation);
    }
    expectCurrentCpuNativeAgreement(checkpoint);
    expect(checkpoint.placement.visibleInstances).toBe(baseline.placement.visibleInstances);
    expect(checkpoint.placement.scoredEntries).toBe(0);
    expect(checkpoint.placement.hiddenPoppers).toBe(0);
    expect(checkpoint.placement.maxLinearVelocity).toBe(0);
    expect(checkpoint.placement.maxAngularVelocity).toBe(0);
    expect(checkpoint.snapshot.lifecycle.retiredWorlds).toBe(0);
    expect(checkpoint.snapshot.contacts.activeAfterStepSubscribers).toBe(baseline.snapshot.contacts.activeAfterStepSubscribers);
}

test("restarts in place after three launches and restores every retained resource and pose", async ({ page }) => {
    test.setTimeout(180_000);
    const gpuErrors: string[] = [];
    page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error" && /validation|destroyed.+(?:buffer|texture)|used in a submit/iu.test(text)) {
            gpuErrors.push(text);
        }
    });
    await openLifecycleHarness(page);

    const report = await lifecycleCommand<RestartWorkloadReport>(page, "restart");

    expect(report.displacedIndices).toHaveLength(3);
    expect(report.disturbed.placement.matrixHashes).not.toEqual(report.baseline.placement.matrixHashes);
    expect(report.disturbed.placement.hiddenPoppers).toBeGreaterThan(0);
    expectRestarted(report.immediate, report.authored, report.baseline);
    expectRestarted(report.afterQueuedPop, report.authored, report.baseline);
    expect(report.afterFrames.identity).toEqual(report.baseline.identity);
    expect(report.afterFrames.resources).toEqual(report.baseline.resources);
    expectCurrentCpuNativeAgreement(report.afterFrames);
    expect(report.aimingMotionDistance).toBeGreaterThan(0.0001);
    expect(report.secondExplosionEvents).toBe(1);
    expect(report.secondExplosion.placement.hiddenPoppers).toBe(1);
    expect(report.final.identity).toEqual(report.baseline.identity);
    expect(report.final.resources).toEqual(report.baseline.resources);
    expect(report.final.placement.hiddenPoppers).toBe(0);
    expect(report.final.snapshot.lifecycle.retiredWorlds).toBe(0);
    expect(report.timings.syncMs).toBeLessThan(1_000);
    expect(report.timings.recoveryMs).toBeLessThan(1_000);
    expect(report.timings.repeatedSyncMs.every((duration) => duration < 1_000)).toBe(true);
    expect(gpuErrors).toEqual([]);
});

test("final disposal releases active and deactivated native resources exactly once", async ({ page }) => {
    await openLifecycleHarness(page);

    const report = await lifecycleCommand<DisposeWorkloadReport>(page, "dispose");

    expect(report.before.placement.hiddenPoppers).toBe(1);
    expect(report.after.resources.bodyReleases - report.before.resources.bodyReleases).toBe(report.before.snapshot.native.bodies.live);
    expect(report.after.snapshot.native.bodies.live).toBe(0);
    expect(report.after.snapshot.native.constraints.live).toBe(0);
    expect(report.repeated.resources).toEqual(report.after.resources);
});
