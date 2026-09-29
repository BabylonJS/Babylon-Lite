import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installWebGpuRenderBundleObserver } from "./webgpu-render-bundle-observer.js";

declare global {
    interface Window {
        __playroomOriginalFetch?: typeof fetch;
        __playroomRotationSamples: string[];
    }
}

const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);
const demoUrl = `http://127.0.0.1:${labTestPort}/lite/demo-playroom.html`;

async function waitForStartupResult(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const canvas = document.getElementById("renderCanvas");
        return canvas?.dataset.ready === "true" || Boolean(canvas?.dataset.error);
    });
}

test("renders the world during a late load and matches source animation lifecycle", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(installWebGpuRenderBundleObserver);
    await page.addInitScript(() => {
        window.__playroomRotationSamples = [];
        const original = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (property: string, value: string | null, priority?: string): void {
            if (property === "--playroom-action-rotation" && value !== null) {
                window.__playroomRotationSamples.push(value);
            }
            original.call(this, property, value, priority);
        };
    });
    let releaseLateAudio!: () => void;
    const lateAudioGate = new Promise<void>((resolve) => {
        releaseLateAudio = resolve;
    });
    await page.route("**/projectile-flight.mp3", async (route) => {
        await lateAudioGate;
        await route.continue();
    });

    try {
        await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
        const canvas = page.locator("#renderCanvas");
        const startup = page.locator("#playroom-startup");
        const art = page.locator("#playroom-startup-art");
        const action = page.locator("#playroom-startup-action");

        await expect(startup).toBeVisible();
        await expect(action).toBeDisabled();
        await expect(action).toHaveAccessibleName(/loading the playroom/i);
        await expect(page.locator(".playroom-hud")).toBeHidden();
        await expect(page.locator("#playroom-kick")).toBeHidden();
        await expect(page.locator("#playroom-next")).toBeHidden();
        await expect(page.locator("#playroom-replay")).toBeHidden();
        await expect(page.locator("#playroom-free")).toBeHidden();
        expect(await startup.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        expect(await art.evaluate((element) => getComputedStyle(element).objectFit)).toBe("contain");
        await expect(action).toHaveCSS("width", "192px");
        await expect(action).toHaveCSS("height", "192px");
        expect(await art.getAttribute("src")).toContain("havok_splash_landscape_outlines.png");
        const loadingBox = await action.boundingBox();
        expect(loadingBox).not.toBeNull();
        expect(1280 - loadingBox!.x - loadingBox!.width).toBeCloseTo(25.6, 0);
        expect(720 - loadingBox!.y - loadingBox!.height).toBeCloseTo(14.4, 0);
        expect(await canvas.getAttribute("data-ready")).toBeNull();

        await expect.poll(() => page.evaluate(() => window.__playroomRotationSamples.slice(0, 3)), { timeout: 5_000 }).toEqual(["0rad", "45rad", "90rad"]);
        expect(await action.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
        await expect.poll(() => action.evaluate((element) => getComputedStyle(element, "::before").transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect.poll(() => page.evaluate(() => window.__playroomRotationSamples.at(-1))).toBe("0rad");
        const reducedSampleCount = await page.evaluate(() => window.__playroomRotationSamples.length);
        await page.waitForTimeout(50);
        expect(await page.evaluate(() => window.__playroomRotationSamples.length)).toBe(reducedSampleCount);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect.poll(() => page.evaluate((count) => window.__playroomRotationSamples.length > count, reducedSampleCount)).toBe(true);

        await page.waitForFunction(
            () => {
                const canvas = document.getElementById("renderCanvas");
                const observation = window.__playroomRenderBundleObservation?.();
                return canvas?.dataset.ready !== "true" && observation?.executedBundles.some((bundle) => bundle.descriptor.colorFormats.length > 0 && bundle.draws.length >= 135);
            },
            undefined,
            { timeout: 60_000 }
        );
        await expect(canvas).toBeVisible();
        await expect(startup).toHaveAttribute("data-state", "loading");
        await expect(action).toBeDisabled();
        expect(await canvas.getAttribute("data-ready")).toBeNull();

        const readySampleStart = await page.evaluate(() => window.__playroomRotationSamples.length);
        releaseLateAudio();
        await waitForStartupResult(page);
        expect(await canvas.getAttribute("data-error")).toBeNull();
        await expect(canvas).toHaveAttribute("data-ready", "true");
        await expect(action).toBeEnabled();
        await expect(action).toHaveAccessibleName("Play");
        expect(await action.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("havok_playButton_landscape_outlines.png");
        await expect(page.locator(".playroom-hud")).toBeHidden();
        await expect(page.locator("#playroom-free")).toBeHidden();
        await expect
            .poll(
                () =>
                    page.evaluate((start) => {
                        const samples = window.__playroomRotationSamples.slice(start);
                        const reset = samples.lastIndexOf("0rad");
                        return reset >= 0 ? samples.slice(reset, reset + 4).map(Number.parseFloat) : [];
                    }, readySampleStart),
                { timeout: 5_000 }
            )
            .toEqual([0, 0.5, Math.cos(0.02) * 0.5, Math.cos(0.04) * 0.5]);

        await page.setViewportSize({ width: 720, height: 1280 });
        await expect(action).toHaveCSS("width", "144px");
        await expect(action).toHaveCSS("height", "144px");
        expect(await art.getAttribute("src")).toContain("havok_splash_portrait_outlines.png");

        await action.focus();
        await page.keyboard.press("Enter");
        await expect(startup).toBeHidden();
        await expect(canvas).toHaveAttribute("data-game-phase", "aiming");
        await expect(page.locator(".playroom-hud")).toBeVisible();
        await expect(page.locator("#playroom-kick")).toBeVisible();
        await expect(page.locator("#playroom-free")).toBeVisible();
        await expect(page.locator("#playroom-kick")).toHaveCSS("width", "144px");
        await expect(page.locator("#playroom-kick")).toHaveCSS("height", "144px");
        const stoppedSampleCount = await page.evaluate(() => window.__playroomRotationSamples.length);
        const stoppedRotation = await action.evaluate((element) => element.style.getPropertyValue("--playroom-action-rotation"));
        await page.waitForTimeout(50);
        expect(await page.evaluate(() => window.__playroomRotationSamples.length)).toBe(stoppedSampleCount);
        expect(await action.evaluate((element) => element.style.getPropertyValue("--playroom-action-rotation"))).toBe(stoppedRotation);
        const freeBox = await page.locator("#playroom-free").boundingBox();
        expect(freeBox).not.toBeNull();
        expect(freeBox!.width).toBeCloseTo(86.4, 1);
        expect(freeBox!.height).toBeCloseTo(86.4, 1);
    } finally {
        releaseLateAudio();
    }
});

test("surfaces startup failures and restores fetch ownership", async ({ page }) => {
    await page.addInitScript(() => {
        window.__playroomOriginalFetch = window.fetch;
    });
    await page.route("**/childRoom_ibl.env", (route) => route.abort("failed"));
    await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
    await waitForStartupResult(page);

    await expect(page.locator("#playroom-startup-error")).toBeVisible();
    await expect(page.locator("#playroom-startup-error")).toContainText("Unable to start The Playroom");
    await expect(page.locator("#playroom-startup-action")).toBeDisabled();
    await expect(page.locator(".playroom-hud")).toBeHidden();
    expect(
        await page.evaluate(() => {
            return window.fetch === window.__playroomOriginalFetch;
        })
    ).toBe(true);
});

test("does not publish ready after page teardown during late audio", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
        window.__playroomOriginalFetch = window.fetch;
    });
    let releaseLateAudio!: () => void;
    let notifyLateAudioRequested!: () => void;
    const lateAudioGate = new Promise<void>((resolve) => {
        releaseLateAudio = resolve;
    });
    const lateAudioRequested = new Promise<void>((resolve) => {
        notifyLateAudioRequested = resolve;
    });
    await page.route("**/projectile-flight.mp3", async (route) => {
        notifyLateAudioRequested();
        await lateAudioGate;
        await route.continue();
    });

    try {
        await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
        await lateAudioRequested;
        await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.gamePhase === "loading");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        releaseLateAudio();
        await page.waitForFunction(() => window.fetch === window.__playroomOriginalFetch);

        await expect(page.locator("#renderCanvas")).not.toHaveAttribute("data-ready", "true");
        await expect(page.locator("#playroom-startup-action")).toBeDisabled();
    } finally {
        releaseLateAudio();
    }
});
