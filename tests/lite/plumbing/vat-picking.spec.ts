import { expect, test } from "../parity/parity-fixtures";

for (const thin of [false, true]) {
    test(`VAT GPU picking matches the ${thin ? "thin-instance" : "regular"} visible projection`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.goto(`/vat-picking-test.html${thin ? "?thin=1" : ""}`);
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });

        const results = await page.evaluate(() => (window as unknown as { __vatPickTest: Record<string, unknown> }).__vatPickTest);
        expect(results.error).toBeNull();
        expect(results.hit).toBe(true);
        expect(results.pickedPoint).not.toBeNull();
        expect(results.thinInstanceIndex).toBe(thin ? 0 : -1);
        if (results.detailed) {
            expect(results.faceId).toBeGreaterThanOrEqual(0);
        } else {
            expect(results.faceId).toBe(-1);
        }
    });
}
