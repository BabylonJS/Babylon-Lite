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

    test("keeps visible descendants accessible when only their scene ancestor is runtime-hidden", async ({ page }) => {
        const region = page.locator("#scene-host").getByRole("region", { name: "Scene", exact: true });
        const parent = region.getByRole("img", { name: "Runtime parent" });
        const child = region.getByRole("button", { name: "Runtime child" });
        const parentElement = await parent.elementHandle();
        const childElement = await child.elementHandle();

        expect(parentElement).not.toBeNull();
        expect(childElement).not.toBeNull();
        await parentElement!.evaluate((element) => Object.assign(window, { runtimeParentElement: element }));
        await childElement!.evaluate((element) => Object.assign(window, { runtimeChildElement: element }));
        await page.evaluate(() => (window as unknown as { accessibilityFixture: { hideRuntimeParent(): void } }).accessibilityFixture.hideRuntimeParent());

        await expect(region.getByRole("img", { name: "Runtime parent" })).toHaveCount(0);
        await expect(child).toHaveCount(1);
        await expect(child).toContainText("Runtime child");
        expect(
            await parentElement!.evaluate((element) => ({
                hidden: (element as HTMLElement).hidden,
                role: (element as HTMLElement).getAttribute("role"),
                label: (element as HTMLElement).getAttribute("aria-label"),
                description: (element as HTMLElement).getAttribute("aria-description"),
                disabled: (element as HTMLElement).getAttribute("aria-disabled"),
                roleDescription: (element as HTMLElement).getAttribute("aria-roledescription"),
                ownText: element.firstElementChild?.textContent,
            }))
        ).toEqual({
            hidden: false,
            role: null,
            label: null,
            description: null,
            disabled: null,
            roleDescription: null,
            ownText: "",
        });

        await page.evaluate(() =>
            (window as unknown as { accessibilityFixture: { authorHideRuntimeParent(hidden: boolean): void } }).accessibilityFixture.authorHideRuntimeParent(true)
        );
        await expect(child).toHaveCount(0);
        expect(await parentElement!.evaluate((element) => (element as HTMLElement).hidden)).toBe(true);

        await page.evaluate(() =>
            (window as unknown as { accessibilityFixture: { authorHideRuntimeParent(hidden: boolean): void } }).accessibilityFixture.authorHideRuntimeParent(false)
        );
        await expect(child).toHaveCount(1);
        expect(await parentElement!.evaluate((element) => (element as HTMLElement).hidden)).toBe(false);

        await page.evaluate(() => (window as unknown as { accessibilityFixture: { showRuntimeParent(): void } }).accessibilityFixture.showRuntimeParent());
        await expect(region.getByRole("img", { name: "Runtime parent" })).toHaveCount(1);
        await expect(region.getByRole("img", { name: "Runtime parent" })).toHaveAttribute("aria-description", "Runtime-hidden parent description");
        await expect(region.getByRole("img", { name: "Runtime parent" })).toHaveAttribute("aria-disabled", "true");
        await expect(region.getByRole("img", { name: "Runtime parent" })).toHaveAttribute("aria-roledescription", "model");
        expect(
            await region
                .getByRole("img", { name: "Runtime parent" })
                .evaluate((element) => element === (window as unknown as { runtimeParentElement: Element }).runtimeParentElement)
        ).toBe(true);
        expect(await child.evaluate((element) => element === (window as unknown as { runtimeChildElement: Element }).runtimeChildElement)).toBe(true);
    });

    test("hides a disposed explicit-root subtree without changing authored visibility", async ({ page }) => {
        const region = page.locator("#scene-host").getByRole("region", { name: "Scene", exact: true });
        const parent = region.getByRole("group", { name: "Disposed parent" });
        const child = region.getByRole("button", { name: "Disposed child" });
        const parentElement = await parent.elementHandle();
        const childElement = await child.elementHandle();

        expect(parentElement).not.toBeNull();
        expect(childElement).not.toBeNull();
        const state = await page.evaluate(() =>
            (
                window as unknown as {
                    accessibilityFixture: {
                        disposeRetainedParent(): {
                            nodeHidden: boolean | undefined;
                            projectedHidden: boolean | undefined;
                            projectedAriaHidden: string | number | boolean | null | undefined;
                            authoredHidden: boolean | undefined;
                            authoredAriaHidden: string | number | boolean | null | undefined;
                        };
                    };
                }
            ).accessibilityFixture.disposeRetainedParent()
        );

        expect(state).toEqual({
            nodeHidden: true,
            projectedHidden: true,
            projectedAriaHidden: true,
            authoredHidden: false,
            authoredAriaHidden: false,
        });
        await expect(region.getByRole("group", { name: "Disposed parent" })).toHaveCount(0);
        await expect(region.getByRole("button", { name: "Disposed child" })).toHaveCount(0);
        expect(await parentElement!.evaluate((element) => (element as HTMLElement).hidden)).toBe(true);
        expect(await childElement!.evaluate((element) => element.isConnected && (element.parentElement as HTMLElement).hidden)).toBe(true);
    });

    test("rejects an HTML twin after scene disposal without DOM or lifecycle registration", async ({ page }) => {
        const result = await page.evaluate(() =>
            (
                window as unknown as { accessibilityFixture: { createAfterDispose(): { error: string | null; hasLifecycleState: boolean } } }
            ).accessibilityFixture.createAfterDispose()
        );

        expect(result.error).toMatch(/disposed/i);
        expect(result.hasLifecycleState).toBe(false);
        await expect(page.getByRole("region", { name: "Disposed scene" })).toHaveCount(0);
        await expect(page.locator("#disposed-accessibility")).toBeEmpty();
    });

    test("releases accessibility state when canonical cleanup throws", async ({ page }) => {
        const result = await page.evaluate(() =>
            (
                window as unknown as {
                    accessibilityFixture: {
                        disposeAfterCleanupFailure(): {
                            error: string | null;
                            treeDisposed: boolean;
                            adapterDisposed: boolean;
                            bindingsReleased: boolean;
                            viewDisposed: boolean;
                            htmlRemoved: boolean;
                            descriptorRestored: boolean;
                        };
                    };
                }
            ).accessibilityFixture.disposeAfterCleanupFailure()
        );

        expect(result).toEqual({
            error: "canonical cleanup failed",
            treeDisposed: true,
            adapterDisposed: true,
            bindingsReleased: true,
            viewDisposed: true,
            htmlRemoved: true,
            descriptorRestored: true,
        });
    });

    test("removes an owned HTML twin when its scene is disposed inside a tree batch", async ({ page }) => {
        const result = await page.evaluate(() =>
            (
                window as unknown as {
                    accessibilityFixture: {
                        disposeDuringAccessibilityBatch(): {
                            treeDisposed: boolean;
                            viewDisposed: boolean;
                            htmlRemoved: boolean;
                        };
                    };
                }
            ).accessibilityFixture.disposeDuringAccessibilityBatch()
        );

        expect(result).toEqual({
            treeDisposed: true,
            viewDisposed: true,
            htmlRemoved: true,
        });
        await expect(page.getByRole("region", { name: "Batched disposal" })).toHaveCount(0);
    });

    test("updates one node without mutating unrelated DOM or publishing no-op refreshes", async ({ page }) => {
        const result = await page.evaluate(() =>
            (
                window as unknown as {
                    accessibilityFixture: {
                        measureSingleNodeUpdate(): Promise<{
                            unrelatedMutations: number;
                            unrelatedIdentityStable: boolean;
                            unrelatedHidden: boolean;
                            level: string | null;
                            busy: string | null;
                            details: string | null;
                            removedLevel: string | null;
                            removedBusy: string | null;
                            noOpMutations: number;
                            noOpNotifications: number;
                        }>;
                    };
                }
            ).accessibilityFixture.measureSingleNodeUpdate()
        );

        expect(result).toEqual({
            unrelatedMutations: 0,
            unrelatedIdentityStable: true,
            unrelatedHidden: true,
            level: "2",
            busy: "false",
            details: null,
            removedLevel: null,
            removedBusy: null,
            noOpMutations: 0,
            noOpNotifications: 0,
        });
    });
});
