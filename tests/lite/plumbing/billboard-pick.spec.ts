import { test, expect } from "../parity/parity-fixtures";

test.describe("GPU Billboard Picking", () => {
    test("pickBillboardSprite hits a clear billboard, misses a corner, and respects mesh occlusion", async ({ page }) => {
        await page.goto("/billboard-pick-test.html");
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 20_000 });

        const r = await page.evaluate(() => (window as any).__bbPickTest);
        expect(r.error).toBeNull();

        // ── Clear billboard → hit, correct sprite index + owning system ──
        expect(r.hitA).not.toBeNull();
        expect(r.hitA.spriteIndex).toBe(r.idxA);
        expect(r.hitA.systemMatch).toBe(true);

        // ── Reused caller-owned picker (overload) resolves the same clear billboard ──
        // Proves pickBillboardSprite reuses a supplied picker and does not dispose it mid-sequence
        // (the picker also served a mesh pick before this call and is disposed once by the test).
        expect(r.reusedHitA).not.toBeNull();
        expect(r.reusedHitA.spriteIndex).toBe(r.idxA);
        expect(r.reusedHitA.systemMatch).toBe(true);

        // ── Occlusion: billboard B sits behind a box in the shared depth pass ──
        // pickBillboardSprite sees nothing there (the billboard is occluded), while the
        // mesh picker resolves the occluding box at the same pixel.
        expect(r.hitB).toBeNull();
        expect(r.meshAtB).toBe("occluder");

        // ── Empty corner → miss ──
        expect(r.miss).toBeNull();
    });
});
