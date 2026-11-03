import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { SCENE348_ASSETS } from "../../../lab/lite/src/shared/scene348-parallax.js";

test.use({ baseURL: `http://127.0.0.1:${process.env.LAB_TEST_PORT ?? 5179}` });

const invalidViewMessage = "Scene 348 view must be front, oblique, or grazing.";

for (const route of ["/scene348.html", "/babylon-ref-scene348.html", "/bundle-scene348.html", "/bundle-bjs-scene348.html", "/lite/compare-scene348.html"]) {
    test(`Scene 348 - reports startup failure for ${route}`, async ({ page }) => {
        if (route.startsWith("/bundle-")) {
            const file = route.includes("bjs") ? "bjs-scene348.js" : "scene348.js";
            test.skip(!existsSync(resolve(__dirname, "..\\..\\..\\lab\\public\\bundle", file)), "Build scene348's production bundles before checking their errors.");
        }
        await page.goto(`${route}?view=invalid`);
        const status = page.locator("[data-scene348-status]");
        await expect(status).toHaveText(invalidViewMessage);
        await expect(status).toBeVisible();
        if (route !== "/lite/compare-scene348.html") {
            await expect(page.locator("canvas")).toHaveAttribute("data-error", invalidViewMessage);
            await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
        }
        if (route === "/scene348.html" || route === "/bundle-scene348.html") {
            await expect(page.locator("#loader-overlay .loader-error")).toHaveText(invalidViewMessage);
            await expect(page.locator("#loader-overlay .loader-ring")).toBeHidden();
        }
    });
}

test("Scene 348 - comparison retains both renderer startup errors", async ({ page }) => {
    await page.route(/\/(?:scene348|babylon-ref-scene348)\.html\?/, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        await route.fulfill({
            response,
            body: html.replace("</head>", '<script>history.replaceState(null, "", "?view=invalid");</script></head>'),
        });
    });
    await page.goto("/lite/compare-scene348.html");
    const status = page.locator("[data-scene348-status]");
    await expect(status).toContainText(`Babylon Lite POM: ${invalidViewMessage}`);
    await expect(status).toContainText(`Babylon.js native POM: ${invalidViewMessage}`);
    await expect(status).toBeVisible();
});

test("Scene 348 - texture startup failures reach the comparison status", async ({ page }) => {
    const color = new PNG({ width: 2, height: 2 });
    color.data.fill(255);
    await page.route(SCENE348_ASSETS.stone.color, (route) => route.fulfill({ contentType: "image/png", body: PNG.sync.write(color) }));
    await page.route(SCENE348_ASSETS.stone.normalHeight, (route) => route.abort("failed"));
    await page.goto("/lite/compare-scene348.html");
    for (const frame of ["#lite-frame", "#babylon-frame"]) {
        const canvas = page.frameLocator(frame).locator("canvas");
        await expect(canvas).toHaveAttribute("data-error", /.+/);
        await expect(canvas).not.toHaveAttribute("data-ready", "true");
    }
    const status = page.locator("[data-scene348-status]");
    await expect(status).toContainText("Babylon Lite POM:");
    await expect(status).toContainText("Babylon.js native POM:");
    await expect(status).toContainText(SCENE348_ASSETS.stone.normalHeight);
});

test("Scene 348 - live recovery clears only the renderer that succeeded", async ({ page }) => {
    const texture = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < texture.data.length; i += 4) {
        texture.data.set([128, 128, 255, 128], i);
    }
    const body = PNG.sync.write(texture);
    let allowLite = false;
    let allowBabylon = false;
    for (const asset of Object.values(SCENE348_ASSETS)) {
        await page.route(asset.color, (route) => route.fulfill({ contentType: "image/png", body }));
    }
    await page.route(SCENE348_ASSETS.stone.normalHeight, (route) => route.fulfill({ contentType: "image/png", body }));
    await page.route(SCENE348_ASSETS.wall.normalHeight, (route) => {
        const lite = route.request().frame().url().includes("/scene348.html");
        return (lite ? allowLite : allowBabylon) ? route.fulfill({ contentType: "image/png", body }) : route.abort("failed");
    });
    await page.goto("/lite/compare-scene348.html");
    const liteCanvas = page.frameLocator("#lite-frame").locator("canvas");
    const babylonCanvas = page.frameLocator("#babylon-frame").locator("canvas");
    for (const canvas of [liteCanvas, babylonCanvas]) {
        await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    }
    await page.locator('select[name="asset"]').selectOption("wall");
    const status = page.locator("[data-scene348-status]");
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
