import { expect, test } from "@playwright/test";

test.describe("scene accessibility HTML", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/lite/accessibility.html");
        await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    });

    test("uses the canvas host and exposes hierarchy and full ARIA", async ({ page }) => {
        const region = page.locator("#scene-host").getByRole("region", { name: "Scene", exact: true });
        const group = region.getByRole("group", { name: "Box arrangement" });
        const centerBox = group.locator('[data-lite-accessibility-node][aria-label="Center box"]');
        const status = region.getByRole("status", { name: "Loading box scene" });

        await expect(page.locator("#scene-host > canvas + .lite-accessibility")).toHaveCount(1);
        await expect(page.locator("#second-scene-host > canvas + .lite-accessibility")).toHaveCount(1);
        await expect(page.locator(".lite-accessibility[id]")).toHaveCount(0);
        await expect(centerBox).toHaveAttribute("aria-description", "The center item in the box group");
        await expect(centerBox).toContainText("Center box");
        await expect(centerBox).toContainText("The center item in the box group");
        await expect(status).toHaveAttribute("aria-live", "polite");
        await expect(status).toHaveAttribute("aria-atomic", "true");
        const descriptionOnly = group.locator("[data-lite-accessibility-node]", { hasText: "The first item in the box group" });
        await expect(descriptionOnly).toHaveAttribute("aria-label", "The first item in the box group");
        await expect(descriptionOnly).not.toHaveAttribute("aria-description");
        await expect(descriptionOnly.locator("[data-lite-accessibility-text]")).toHaveText("The first item in the box group");
        await expect(region.locator("button, input, select, textarea, a[href], [tabindex]")).toHaveCount(0);
        await expect(centerBox).toHaveJSProperty("tagName", "DIV");
        await expect(page.getByRole("region", { name: "Custom host scene" })).toHaveCount(1);
        const iframe = page.locator("#iframe-host").contentFrame();
        await expect(iframe.getByRole("region", { name: "Iframe scene" })).toHaveCount(1);
    });

    test("updates roles, ARIA, hierarchy, visibility, removal, and disposal", async ({ page }) => {
        const region = page.locator("#scene-host").getByRole("region", { name: "Scene", exact: true });
        const status = region.getByRole("status", { name: "Loading box scene" });
        const centerBox = region.locator('[data-lite-accessibility-node][aria-label="Center box"]');

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { replace(): void } }).accessibilityFixture.replace());
        await expect(status).toHaveCount(0);
        const note = region.getByRole("note", { name: "Box scene ready" });
        await expect(note).not.toHaveAttribute("aria-live");
        await expect(note).not.toHaveAttribute("aria-atomic");
        await expect(note).toContainText("All <three> box records are available");
        await expect(note).not.toContainText("&lt;three&gt;");

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { hide(hidden: boolean): void } }).accessibilityFixture.hide(true));
        await expect(centerBox).toBeHidden();
        await page.evaluate(() => (window as unknown as { accessibilityFixture: { hide(hidden: boolean): void } }).accessibilityFixture.hide(false));
        await expect(centerBox).toBeVisible();

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { reparent(): void } }).accessibilityFixture.reparent());
        await expect(region.locator(':scope > [data-lite-accessibility-node][aria-label="Center box"]')).toHaveCount(1);

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { remove(): void } }).accessibilityFixture.remove());
        await expect(centerBox).toHaveCount(0);

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { dispose(): void } }).accessibilityFixture.dispose());
        await expect(region).toHaveCount(0);
        await expect(page.locator("#renderCanvas")).toHaveCount(1);
        await expect(page.locator("#scene-host")).toHaveCount(1);
    });

    test("rejects an HTML twin after scene disposal without leaking DOM or a binding", async ({ page }) => {
        const result = await page.evaluate(() =>
            (window as unknown as { accessibilityFixture: { createAfterDispose(): { error: string | null; hasBinding: boolean } } }).accessibilityFixture.createAfterDispose()
        );

        expect(result.error).toMatch(/disposed/i);
        expect(result.hasBinding).toBe(false);
        await expect(page.getByRole("region", { name: "Disposed scene" })).toHaveCount(0);
        await expect(page.locator("#disposed-accessibility")).toBeEmpty();
    });
});
