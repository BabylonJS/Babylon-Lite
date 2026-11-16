import { expect, test } from "@playwright/test";

test("3D source test samples all eight texels and their trilinear midpoint", async ({ page }) => {
    await page.goto("/gl/texture-3d-test.html");
    await expect(page.locator("#renderCanvas")).toHaveAttribute("data-result", "passed");
    await expect(page.locator("#result")).toContainText("PASS");
});

test("3D source test samples the restored volume", async ({ page }) => {
    await page.goto("/gl/texture-3d-test.html");
    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-result", "passed");

    const supported = await page.evaluate(async () => {
        const element = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const extension = element.getContext("webgl2")!.getExtension("WEBGL_lose_context");
        if (!extension) {
            return false;
        }
        const restored = new Promise<void>((resolve) => element.addEventListener("webglcontextrestored", () => resolve(), { once: true }));
        extension.loseContext();
        setTimeout(() => extension.restoreContext(), 0);
        await restored;
        return true;
    });
    test.skip(!supported, "WEBGL_lose_context is unavailable");
    await expect(canvas).toHaveAttribute("data-restorations", "1");
    await expect(canvas).toHaveAttribute("data-result", "passed");
});
