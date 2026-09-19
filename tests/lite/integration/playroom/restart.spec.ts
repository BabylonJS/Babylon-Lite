import { expect, test } from "@playwright/test";
import { lifecycleCommand, openLifecycleHarness } from "./fixtures.js";
import type { DisposeWorkloadReport, RestartCheckpoint, RestartWorkloadReport } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

function expectRestarted(checkpoint: RestartCheckpoint, baseline: RestartCheckpoint): void {
    expect(checkpoint.identity).toEqual(baseline.identity);
    expect(checkpoint.resources).toEqual(baseline.resources);
    expect(checkpoint.placement.matrixHashes).toEqual(baseline.placement.matrixHashes);
    expect(checkpoint.placement.samples).toEqual(baseline.placement.samples);
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
    expectRestarted(report.immediate, report.baseline);
    expectRestarted(report.afterQueuedPop, report.baseline);
    expect(report.afterFrames.identity).toEqual(report.baseline.identity);
    expect(report.afterFrames.resources).toEqual(report.baseline.resources);
    expect(report.afterFrames.placement.gpuHashes).toEqual(report.afterFrames.placement.matrixHashes);
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
