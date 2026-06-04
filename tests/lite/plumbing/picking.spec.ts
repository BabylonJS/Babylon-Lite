import { test, expect } from "@playwright/test";

test.describe("GPU Picking", () => {
    test("pickAsync hits a sphere at canvas center and misses at corner", async ({ page }) => {
        await page.goto("/picking-test.html");
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });

        const results = await page.evaluate(() => (window as any).__pickTest);
        expect(results.error).toBeNull();

        // ── Center pick should hit ───────────────────────────────
        expect(results.centerPick).not.toBeNull();
        expect(results.centerPick.hit).toBe(true);
        expect(results.centerPick.meshName).toBe("test-sphere");
        expect(results.centerPick.distance).toBeGreaterThan(0);
        expect(results.centerPick.pickedPoint).not.toBeNull();
        expect(results.centerPick.thinInstanceIndex).toBe(-1);

        // Picked point should be near the sphere surface (radius ~0.5, camera at z=5)
        const [px, py, pz] = results.centerPick.pickedPoint;
        const distFromOrigin = Math.sqrt(px * px + py * py + pz * pz);
        expect(distFromOrigin).toBeGreaterThan(0.3);
        expect(distFromOrigin).toBeLessThan(1.5);

        // ── Detailed picking: faceId, barycentric, normal, UV ───
        expect(results.centerPick.faceId).toBeGreaterThanOrEqual(0);
        expect(results.centerPick.bu).toBeGreaterThanOrEqual(0);
        expect(results.centerPick.bv).toBeGreaterThanOrEqual(0);
        expect(results.centerPick.bu + results.centerPick.bv).toBeLessThanOrEqual(1.01); // allow tiny float error

        // Normal should be roughly pointing toward camera (positive or negative Z depending on LH)
        expect(results.centerPick.normal).not.toBeNull();
        const [nx, ny, nz] = results.centerPick.normal;
        const normalLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        expect(normalLen).toBeCloseTo(1.0, 1); // unit normal

        // UV should be in [0, 1]
        expect(results.centerPick.uv).not.toBeNull();
        const [u, v] = results.centerPick.uv;
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);

        // ── Corner pick should miss ─────────────────────────────
        expect(results.missPick).not.toBeNull();
        expect(results.missPick.hit).toBe(false);
    });
});
