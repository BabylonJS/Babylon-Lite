import { expect, test } from "../parity-fixtures";

test("Ocean demo initializes deterministic paused and animated seeks without WebGPU errors", async ({ page }) => {
    test.setTimeout(180_000);
    const gpuErrors: string[] = [];
    page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error" || /GPUValidationError|destroyed .*submit|validation error/i.test(text)) {
            gpuErrors.push(text);
        }
    });
    page.on("pageerror", (error) => gpuErrors.push(error.message));

    await page.goto("/demo-ocean.html?seekTime=0.1");
    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 120_000 });
    await expect(canvas).toHaveAttribute("data-animation-frozen", "true");
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const shadows = page.getByLabel("Enable shadows");
    await page.keyboard.press("F8");
    const shadowed = await canvas.screenshot();
    await shadows.evaluate((element) => {
        (element as HTMLInputElement).checked = false;
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const unshadowed = await canvas.screenshot();
    await shadows.evaluate((element) => {
        (element as HTMLInputElement).checked = true;
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const restored = await canvas.screenshot();
    expect(unshadowed.equals(shadowed)).toBe(false);
    expect(restored.equals(shadowed)).toBe(true);
    await page.keyboard.press("F8");
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(canvas).toHaveAttribute("data-animation-frozen", "false");

    await page.goto("/demo-ocean.html?seekTime=0.1&animate=true");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 120_000 });
    await expect(canvas).toHaveAttribute("data-animation-frozen", "false");
    await expect(canvas).not.toHaveAttribute("data-error", /./);
    expect(gpuErrors).toEqual([]);

    await page.goto("/demo-ocean-reference.html?seekTime=Infinity");
    await expect(page.locator("#renderCanvas")).toHaveAttribute("data-error", /finite and non-negative/, { timeout: 30_000 });
});
