import { expect, test } from "@playwright/test";

test("presentation covers the canvas and keeps the scissor rectangle, with cached and wiped state", async ({ page }) => {
    await page.goto("/gl/present-scissor-test.html");
    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-result", /passed|failed/);
    test.info().annotations.push({ type: "renderer", description: `${await canvas.getAttribute("data-renderer")} (samples ${await canvas.getAttribute("data-samples")})` });
    await expect(page.locator("#result")).toContainText("PASS");
    await expect(canvas).toHaveAttribute("data-result", "passed");
});
