import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { SCENE349_ASSETS } from "../../../lab/lite/src/shared/scene349-parallax.js";

test.use({ baseURL: `http://127.0.0.1:${process.env.LAB_TEST_PORT ?? 5179}` });

const invalidViewMessage = "Scene 349 view must be front, oblique, or grazing.";
const bundleDirectory = resolve(__dirname, "..", "..", "..", "lab", "public", "bundle");

for (const route of ["/scene349.html", "/babylon-ref-scene349.html", "/bundle-scene349.html", "/bundle-bjs-scene349.html", "/lite/compare-scene349.html"]) {
    test(`Scene 349 - reports startup failure for ${route}`, async ({ page }) => {
        if (route.startsWith("/bundle-")) {
            const file = route.includes("bjs") ? "bjs-scene349.js" : "scene349.js";
            test.skip(!existsSync(resolve(bundleDirectory, file)), "Build scene349's production bundles before checking their errors.");
        }
        await page.goto(`${route}?view=invalid`);
        const status = page.locator("[data-scene349-status]");
        await expect(status).toHaveText(invalidViewMessage);
        await expect(status).toBeVisible();
        if (route !== "/lite/compare-scene349.html") {
            await expect(page.locator("canvas")).toHaveAttribute("data-error", invalidViewMessage);
            await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
        }
        if (route === "/scene349.html" || route === "/bundle-scene349.html") {
            await expect(page.locator("#loader-overlay .loader-error")).toHaveText(invalidViewMessage);
            await expect(page.locator("#loader-overlay .loader-ring")).toBeHidden();
        }
    });
}

test("Scene 349 - comparison retains both renderer startup errors", async ({ page }) => {
    await page.route(/\/(?:scene349|babylon-ref-scene349)\.html\?/, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({
            response,
            body: html.replace("</head>", '<script>history.replaceState(null, "", "?view=invalid");</script></head>'),
        });
    });
    await page.goto("/lite/compare-scene349.html");
    const status = page.locator("[data-scene349-status]");
    await expect(status).toContainText(`Babylon Lite POM: ${invalidViewMessage}`);
    await expect(status).toContainText(`Babylon.js native POM: ${invalidViewMessage}`);
    await expect(status).toBeVisible();
});

test("Scene 349 - texture startup failures reach the comparison status", async ({ page }) => {
    const color = new PNG({ width: 2, height: 2 });
    color.data.fill(255);
    await page.route(SCENE349_ASSETS.stone.color, (route) => route.fulfill({ contentType: "image/png", body: PNG.sync.write(color) }));
    await page.route(SCENE349_ASSETS.stone.normalHeight, (route) => route.abort("failed"));
    await page.goto("/lite/compare-scene349.html");
    for (const frame of ["#lite-frame", "#babylon-frame"]) {
        const canvas = page.frameLocator(frame).locator("canvas");
        await expect(canvas).toHaveAttribute("data-error", /.+/);
        await expect(canvas).not.toHaveAttribute("data-ready", "true");
    }
    const status = page.locator("[data-scene349-status]");
    await expect(status).toContainText("Babylon Lite POM:");
    await expect(status).toContainText("Babylon.js native POM:");
    await expect(status).toContainText(SCENE349_ASSETS.stone.normalHeight);
});

test("Scene 349 - live recovery clears only the renderer that succeeded", async ({ page }) => {
    const texture = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < texture.data.length; i += 4) {
        texture.data.set([128, 128, 255, 128], i);
    }
    const body = PNG.sync.write(texture);
    let allowLite = false;
    let allowBabylon = false;
    for (const asset of Object.values(SCENE349_ASSETS)) {
        await page.route(asset.color, (route) => route.fulfill({ contentType: "image/png", body }));
    }
    await page.route(SCENE349_ASSETS.stone.normalHeight, (route) => route.fulfill({ contentType: "image/png", body }));
    await page.route(SCENE349_ASSETS.wall.normalHeight, (route) => {
        const lite = route.request().frame().url().includes("/scene349.html");
        return (lite ? allowLite : allowBabylon) ? route.fulfill({ contentType: "image/png", body }) : route.abort("failed");
    });
    await page.goto("/lite/compare-scene349.html");
    const liteCanvas = page.frameLocator("#lite-frame").locator("canvas");
    const babylonCanvas = page.frameLocator("#babylon-frame").locator("canvas");
    for (const canvas of [liteCanvas, babylonCanvas]) {
        await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    }
    await page.locator('select[name="asset"]').selectOption("wall");
    const status = page.locator("[data-scene349-status]");
    await expect(status).toContainText("Babylon Lite POM:");
    await expect(status).toContainText("Babylon.js native POM:");
    allowLite = true;
    const setDepth = async (value: string): Promise<void> => {
        await page.locator('input[name="depth"]').evaluate((element, depth) => {
            const input = element as HTMLInputElement;
            input.value = depth;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
    };
    await setDepth("0.07");
    await expect(liteCanvas).toHaveAttribute("data-asset", "wall");
    await expect(liteCanvas).toHaveAttribute("data-updating", "false");
    await expect(liteCanvas).not.toHaveAttribute("data-error");
    await expect(status).not.toContainText("Babylon Lite POM:");
    await expect(status).toContainText("Babylon.js native POM:");
    await expect(babylonCanvas).toHaveAttribute("data-error", /.+/);
    allowBabylon = true;
    await setDepth("0.08");
    for (const canvas of [liteCanvas, babylonCanvas]) {
        await expect(canvas).toHaveAttribute("data-asset", "wall");
        await expect(canvas).toHaveAttribute("data-depth", "0.08");
        await expect(canvas).toHaveAttribute("data-updating", "false");
        await expect(canvas).not.toHaveAttribute("data-error");
    }
    await expect(status).toHaveText("");
});

for (const route of ["/scene349.html", "/babylon-ref-scene349.html", "/bundle-scene349.html", "/bundle-bjs-scene349.html", "/lite/compare-scene349.html"]) {
    test(`Scene 349 - reverting a failed live update clears errors without reload for ${route}`, async ({ page }) => {
        if (route.startsWith("/bundle-")) {
            const file = route.includes("bjs") ? "bjs-scene349.js" : "scene349.js";
            test.skip(!existsSync(resolve(bundleDirectory, file)), "Build scene349's production bundles before checking their recovery.");
        }
        const texture = new PNG({ width: 2, height: 2 });
        for (let i = 0; i < texture.data.length; i += 4) {
            texture.data.set([128, 128, 255, 128], i);
        }
        const body = PNG.sync.write(texture);
        for (const asset of Object.values(SCENE349_ASSETS)) {
            await page.route(asset.color, (route) => route.fulfill({ contentType: "image/png", body }));
        }
        await page.route(SCENE349_ASSETS.stone.normalHeight, (route) => route.fulfill({ contentType: "image/png", body }));
        let failedRequests = 0;
        await page.route(SCENE349_ASSETS.wall.normalHeight, (route) => {
            failedRequests++;
            return route.abort("failed");
        });
        await page.goto(route);
        const canvases =
            route === "/lite/compare-scene349.html"
                ? [page.frameLocator("#lite-frame").locator("canvas"), page.frameLocator("#babylon-frame").locator("canvas")]
                : [page.locator("canvas")];
        for (const canvas of canvases) {
            await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
            await canvas.evaluate((element) => {
                (element as HTMLCanvasElement).dataset.testIdentity = "revert-after-failure";
            });
        }
        const timeOrigins = await Promise.all(canvases.map((canvas) => canvas.evaluate(() => performance.timeOrigin)));
        const versions = await Promise.all(canvases.map(async (canvas) => Number(await canvas.getAttribute("data-settings-version"))));
        await page.locator('select[name="asset"]').selectOption("wall");
        for (const canvas of canvases) {
            await expect(canvas).toHaveAttribute("data-error", /.+/);
            await expect(canvas).toHaveAttribute("data-updating", "false");
            await expect(canvas).toHaveAttribute("data-asset", "stone");
        }
        const status = page.locator("[data-scene349-status]");
        await expect(status).toHaveText(/.+/);
        await expect(status).toHaveClass(/scene-error/);
        expect(failedRequests).toBeGreaterThan(0);
        const requestsBeforeRecovery = failedRequests;
        await page.locator('select[name="asset"]').selectOption("stone");
        for (let i = 0; i < canvases.length; i++) {
            const canvas = canvases[i]!;
            await expect(canvas).not.toHaveAttribute("data-error");
            await expect(canvas).toHaveAttribute("data-updating", "false");
            await expect(canvas).toHaveAttribute("data-asset", "stone");
            await expect(canvas).toHaveAttribute("data-settings-version", String(versions[i]! + 1));
            await expect(canvas).toHaveAttribute("data-test-identity", "revert-after-failure");
            expect(await canvas.evaluate(() => performance.timeOrigin)).toBe(timeOrigins[i]);
        }
        await expect(status).toHaveText("");
        await expect(status).not.toHaveClass(/scene-error/);
        expect(failedRequests).toBe(requestsBeforeRecovery);
    });
}
