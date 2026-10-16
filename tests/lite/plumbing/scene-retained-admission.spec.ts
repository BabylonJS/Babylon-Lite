import { test, expect } from "@playwright/test";
import type { HierarchyResults } from "../../../lab/lite/src/scene-retained-admission-test.js";

test("duplicate parent restores descendants with fresh native rendering and CPU/GPU picking without recreating geometry", async ({ page }) => {
    await page.goto("/lite/scene-retained-admission-test.html");
    await page.waitForFunction("window.retainedHierarchyTest?.ready || window.retainedHierarchyTest?.error");
    const result = await page.evaluate<HierarchyResults>("window.retainedHierarchyTest");
    await test.info().attach("hierarchy-metrics", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.error).toBeNull();
    expect(result.ready).toBe(true);
    expect(result.order).toEqual(["parent", "peer", "child"]);
    expect(result.freshOrder).toEqual(["parent", "peer", "child", "fresh"]);
    expect(result.detachedHit).toBe(false);
    expect(result.restoredHit).toBe("child");
    expect(result.freshHit).toBe("fresh");
    expect(result.cpuRestored).toBe(true);
    expect(result.sameGeometry).toBe(true);
    expect(result.geometryAllocations).toEqual([12, 12]);
    expect(result.childDestroys).toBe(4);
    expect(result.pixels[0]![0]).toBeGreaterThan(result.pixels[0]![2]!);
    expect(result.pixels[1]).toEqual(result.pixels[2]);
    expect(result.gpuErrors).toEqual([]);
});
