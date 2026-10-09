import { test, expect } from "@playwright/test";
import type { RetentionResults } from "../../../lab/lite/src/mesh-retention-test.js";

test("retained mesh detach/reinsert uses fresh render order, excludes picks and reuses geometry for 1000 activations", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/lite/mesh-retention-test.html");
    await page.waitForFunction("window.meshRetentionTest?.ready || window.meshRetentionTest?.error", undefined, { timeout: 160_000 });
    const results = await page.evaluate<RetentionResults>("window.meshRetentionTest");
    await test.info().attach("mesh-retention-metrics", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
    expect(results.error).toBeNull();
    expect(results.ready).toBe(true);
    expect(results.gpuErrors).toEqual([]);
    expect(results.cycleCount).toBe(1000);
    expect(results.maxGroupOutputs).toBeLessThanOrEqual(2);
    expect(results.geometryAllocations).toHaveLength(2);
    expect(results.geometryAllocations[1]).toBe(results.geometryAllocations[0]);
    expect(results.retainedDestroys).toBe(0);
    expect(results.finalDestroys).toBe(4);
    expect(results.cpuDetachedHit).toBe(false);
    expect(results.gpuDetachedHit).toBe(false);
    expect(results.pendingGpuHit).toBe(false);
    expect(results.queuedGpuHit).toBe(false);
    expect(results.gpuRestoredName).toBe("red");
    expect(results.identityPreserved).toBe(true);
    expect(results.detachedMaterialSwap).toBe(true);
    expect(results.pixels.swapped![1]).toBeGreaterThan(results.pixels.swapped![0]!);
    expect(results.pixels.swapped![1]).toBeGreaterThan(results.pixels.swapped![2]!);
    expect(results.uniqueDetachedUpdate).toBe(true);
    expect(results.detachedBoundsUpdated).toBe(true);
    expect(results.recoveredDetached).toBe(true);
    expect(results.recoveredPickName).toBe("red");
    expect(results.pixels.recovered).toEqual(results.pixels.fresh);
    expect(results.legacyReaddRejected).toBe(true);
    expect(results.finalReaddRejected).toBe(true);
    expect(results.pixels.initial).not.toEqual(results.pixels.detached);
    expect(results.pixels.initial).not.toEqual(results.pixels.reinserted);
    expect(results.pixels.reinserted).toEqual(results.pixels.fresh);
    expect(results.pixels.cycled).toEqual(results.pixels.fresh);
    expect(results.pixels.shaderInitial![1]).toBeGreaterThan(0);
    expect(results.pixels.shaderDetached).toEqual([0, 0, 0, 255]);
    expect(results.pixels.shaderReinserted).toEqual(results.pixels.shaderInitial);
    expect(results.pixels.shaderCycled).toEqual(results.pixels.shaderInitial);
    for (const name of ["initial", "detached", "reinserted", "cycled", "fresh"]) {
        expect(results.pixels[name]).toHaveLength(4);
    }
    expect(results.pixels.detached![0]).toBe(0);
    expect(results.pixels.detached![2]).toBeGreaterThan(0);
    expect(results.pixels.reinserted![0]).toBeGreaterThan(results.pixels.reinserted![2]!);
});
