import { expect, test } from "@playwright/test";
import { lifecycleCommand, lifecycleStage, openLifecycleHarness } from "./fixtures.js";
import type { LifecycleSnapshot, LifecycleWorkloadReport } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("keeps one collision drain subscription during bounded idle simulation", async ({ page }) => {
    await openLifecycleHarness(page);
    const before = await lifecycleCommand<LifecycleSnapshot>(page, "snapshot");
    const after = await lifecycleCommand<LifecycleSnapshot>(page, "wait", 120);

    expect(after.sourceRevision).toBe("d22ce23ef308e28d1f8b6598b4c72ea944205925");
    expect(after.mode).toBe("normal");
    expect(after.contacts.activeAfterStepSubscribers).toBe(2);
    expect(after.contacts.drains - before.contacts.drains).toBe(after.frames.fixedPhysicsSteps - before.frames.fixedPhysicsSteps);
    expect(after.frames.wallMs.count).toBeGreaterThan(0);
    expect(after.frames.javascriptMs.count).toBeGreaterThan(0);
    expect(after.native.bodies.live).toBe(1970);
    expect(after.native.constraints.live).toBe(9);
    expect(after.lifecycle.retiredWorlds).toBe(0);
});

test("records launch, maximum explosions, quiet retention, three throws, and repeated replay", async ({ page }) => {
    test.setTimeout(180_000);
    const gpuErrors: string[] = [];
    page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error" && /validation|destroyed.+(?:buffer|texture)|used in a submit/iu.test(text)) {
            gpuErrors.push(text);
        }
    });
    await openLifecycleHarness(page);
    const report = await lifecycleCommand<LifecycleWorkloadReport>(page, "full");
    const idle = lifecycleStage(report, "idle");
    const maximum = lifecycleStage(report, "maximum-explosions");
    const quiet = lifecycleStage(report, "quiet");
    const threeThrows = lifecycleStage(report, "three-throws");
    const firstReplayRetired = lifecycleStage(report, "first-replay-retired");
    const replayBurst = lifecycleStage(report, "replay-burst");
    const postRetirement = lifecycleStage(report, "post-retirement");

    expect(report.workload.firstExplosions).toBe(1);
    expect(report.workload.firstExplosions + report.workload.remainingExplosions).toBeLessThanOrEqual(16);
    expect(report.workload.maximumPopperEvents).toBe(16);
    expect(report.workload.completedThrows).toBe(3);
    expect(report.workload.replayCount).toBe(3);
    expect(maximum.effects.confetti).toBe(2000);
    expect(quiet.effects.confetti).toBe(2000);
    expect(quiet.effects.descriptorRebuilds - maximum.effects.descriptorRebuilds).toBeGreaterThanOrEqual(quiet.effects.confetti * 110);
    expect(threeThrows.phase).toBe("ended");
    expect(threeThrows.throwCount).toBe(3);
    expect(replayBurst.lifecycle.retiredWorlds).toBeGreaterThanOrEqual(2);
    expect(postRetirement.lifecycle.retiredWorlds).toBe(0);
    expect(postRetirement.lifecycle.sceneMeshes).toBe(idle.lifecycle.sceneMeshes);
    expect(postRetirement.lifecycle.nodeRenderables).toBe(firstReplayRetired.lifecycle.nodeRenderables);
    expect(postRetirement.lifecycle.nodeGroupRenderables).toBe(firstReplayRetired.lifecycle.nodeGroupRenderables);
    expect(postRetirement.lifecycle.meshDisposerOwners).toBe(idle.lifecycle.meshDisposerOwners);
    expect(postRetirement.lifecycle.auxDisposerOwners).toBe(idle.lifecycle.auxDisposerOwners);
    expect(postRetirement.native.bodies.live).toBe(idle.native.bodies.live);
    expect(postRetirement.native.constraints.live).toBe(9);
    expect(postRetirement.contacts.activeAfterStepSubscribers).toBe(2);
    expect(postRetirement.contacts.resolutions.calls).toBe(postRetirement.contacts.events * 2);
    expect(postRetirement.contacts.resolutions.successes).toBe(postRetirement.contacts.resolutions.calls);
    expect(postRetirement.contacts.resolutions.misses).toBe(0);
    expect(postRetirement.contacts.resolutions.thinLinearScans).toBe(0);
    expect(postRetirement.gpuWrites.calls).toBeGreaterThan(0);
    expect(postRetirement.gpuWrites.sourceBytes).toBeGreaterThan(0);
    expect(gpuErrors).toEqual([]);
});
