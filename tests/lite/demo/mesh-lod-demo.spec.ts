/**
 * MeshLoD demo — standalone workflow verification (REQ-VERIFY-6, REQ-DEMO-1..7).
 *
 * Drives the PRODUCTION-BUNDLED demo (`/lite/bundle/demos/mesh-lod.js`, built by
 * `pnpm build:bundle-demo mesh-lod`) in real WebGPU and asserts the shipped
 * controls, diagnostics, debug views, camera pose, and loading/error state.
 * No golden images, no performance test.
 *
 * Run: pnpm build:bundle-demo mesh-lod && npx playwright test tests/lite/demo/mesh-lod-demo.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const PORT = Number(process.env.LAB_TEST_PORT ?? 5179);
const URL = `http://localhost:${PORT}/demo-mesh-lod.html`;
const COARSE_MIN = 46; // per-asset coarse terminal LOD is ~46 triangles; the whole statue always exceeds this

async function waitReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const c = document.getElementById("renderCanvas");
            return c?.dataset.ready === "true" || !!c?.dataset.error;
        },
        { timeout: 60_000 }
    );
    const error = await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.error);
    expect(error, "demo should not report a bootstrap error").toBeFalsy();
}

const metric = (page: Page, id: string): Promise<string> => page.$eval(`[data-metric="${id}"]`, (e) => (e.textContent ?? "").trim());
const metricNumber = async (page: Page, id: string): Promise<number> => Number((await metric(page, id)).replace(/[^\d.-]/g, ""));
const canvasShot = (page: Page): Promise<Buffer> => page.locator("#renderCanvas").screenshot({ type: "jpeg", quality: 40 });

test.describe.configure({ mode: "serial" });

test.describe("MeshLoD demo workflow", () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await waitReady(page);
    });

    test.afterAll(async () => {
        await page.close();
    });

    test("REQ-DEMO-1/2: ready state, three instances, streamed .mlod", async () => {
        await page.waitForFunction(() => Number((document.querySelector('[data-metric="rendered"]')?.textContent ?? "0").replace(/[^\d]/g, "")) > 46, null, { timeout: 30_000 });
        expect(await metric(page, "selection")).toBe("GPU");
        expect(await metricNumber(page, "visible")).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.ready)).toBe("true");
        expect(await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.instanceCount)).toBe("3");
        expect(
            await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.instanceHandedness),
            "MeshLoD instances must inherit the glTF importer's RH-to-LH root transform so winding and orientation match the source meshes"
        ).toBe("negative,negative,negative");
        expect(await metricNumber(page, "src")).toBeGreaterThan(300_000);
        // Loading overlay hidden once ready.
        await expect(page.locator("#loadingOverlay")).toHaveCount(0, { timeout: 5_000 });
    });

    test("REQ-DEMO-5: diagnostics are live, MiB-labelled, and GPU timing is explicit", async () => {
        expect(await metricNumber(page, "rendered")).toBeGreaterThan(COARSE_MIN);
        expect(await metric(page, "downloaded")).toMatch(/MiB$/);
        expect(await metric(page, "gpuCache")).toMatch(/MiB \/ .*MiB$/);
        expect(await metric(page, "cpuCache")).toMatch(/MiB$/);
        expect(await metricNumber(page, "depth")).toBeGreaterThanOrEqual(12);
        expect(await metric(page, "sseSel")).toMatch(/px$/);
        expect(await metric(page, "sseUnmet")).toMatch(/px$/);
        // GPU timing is an explicit status, never a fake "0.00 ms".
        const timing = await metric(page, "gpuTiming");
        expect(timing).not.toBe("0.00 ms");
        expect(timing === "unsupported" || timing === "pending…" || timing === "disabled" || /ms$/.test(timing)).toBeTruthy();
    });

    test("REQ-DEMO-4: controls change effective values", async () => {
        await page.$eval("#mlod-sse", (el: HTMLInputElement) => {
            el.value = "8";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect((await page.textContent("#mlod-sse-value"))?.trim()).toBe("8.0 px");

        await page.$eval("#mlod-budget", (el: HTMLInputElement) => {
            el.value = "64";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect((await page.textContent("#mlod-budget-value"))?.trim()).toBe("64 MiB");

        await page.$eval("#mlod-latency", (el: HTMLInputElement) => {
            el.value = "250";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect((await page.textContent("#mlod-latency-value"))?.trim()).toBe("250 ms");

        // Unlimited bandwidth toggle.
        await page.check("#mlod-bandwidth-unlimited");
        expect((await page.textContent("#mlod-bandwidth-value"))?.trim()).toBe("Unlimited");
        await page.uncheck("#mlod-bandwidth-unlimited");

        // No validation error surfaced.
        expect(((await page.textContent(".hud-status")) ?? "").trim()).toBe("");
        // Reset SSE back to a refining threshold.
        await page.$eval("#mlod-sse", (el: HTMLInputElement) => {
            el.value = "2";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
    });

    test("REQ-DEMO-6: shipped debug views recolor with a legend and keep the statue complete", async () => {
        const none = await canvasShot(page);
        await expect(page.locator("#mlod-debug option")).toHaveCount(3);
        for (const view of ["meshlet-id", "lod-depth"]) {
            await page.selectOption("#mlod-debug", view);
            await page.waitForTimeout(700);
            await expect(page.locator("#meshLodLegend .hud-section-title")).toHaveText(view === "meshlet-id" ? "Meshlet ID" : "LOD depth");
            expect(Buffer.compare(await canvasShot(page), none)).not.toBe(0); // recolored
            expect(await metricNumber(page, "rendered")).toBeGreaterThan(COARSE_MIN); // still complete
            expect(await metric(page, "selection")).toBe("CPU"); // debug uses reference selection
        }
        await page.selectOption("#mlod-debug", "none");
        await page.waitForTimeout(400);
        expect(((await page.textContent("#meshLodLegend")) ?? "").trim()).toBe("");
    });

    test("short desktop viewport keeps the debug selector clear of the legend", async () => {
        const viewport = page.viewportSize()!;
        try {
            await page.setViewportSize({ width: 1024, height: 600 });
            await page.selectOption("#mlod-debug", "meshlet-id");
            const controls = (await page.locator("#meshLodControls").boundingBox())!;
            const legend = (await page.locator("#meshLodLegend").boundingBox())!;
            expect(controls.y + controls.height).toBeLessThanOrEqual(legend.y);
            await page.locator("#mlod-debug").scrollIntoViewIfNeeded();
            await expect(page.locator("#mlod-debug")).toBeInViewport();
            await page.selectOption("#mlod-debug", "none");
        } finally {
            await page.setViewportSize(viewport);
        }
    });

    test("REQ-DEMO-7: pausing streaming keeps resident geometry visible", async () => {
        await page.check("#mlod-pause");
        await expect(page.locator('[data-metric="streaming"]')).toHaveText("paused");
        expect(await metricNumber(page, "rendered")).toBeGreaterThan(COARSE_MIN);

        await page.uncheck("#mlod-pause");
        await expect(page.locator('[data-metric="streaming"]')).toHaveText("active");
    });

    test("REQ-DEMO-3: orbit and zoom change the view", async () => {
        const box = (await page.locator("#renderCanvas").boundingBox())!;
        const before = await canvasShot(page);
        // Orbit (drag).
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 40, { steps: 10 });
        await page.mouse.up();
        // Zoom (wheel).
        await page.mouse.wheel(0, -500);
        await page.waitForTimeout(500);
        expect(Buffer.compare(await canvasShot(page), before)).not.toBe(0);
    });

    test("the single shipped model is named and credited without an inactive selector", async () => {
        await expect(page.locator("#meshLodModel")).toHaveCount(0);
        await expect(page.locator("#meshLodControls .hud-heading")).toContainText("Harvard-Yenching Institute statue");
        expect(await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.sourceGlb)).toBe(
            "https://raw.githubusercontent.com/BabylonJS/Assets/master/meshes/harvard-yenching/harvard-yenching_institute_statue.glb"
        );
        await expect(page.locator(".credit")).toBeVisible();
    });
});

test.describe("MeshLoD demo — deterministic camera path", () => {
    const DEG = Math.PI / 180;
    const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) <= eps;

    async function poseAt(page: Page, t: number): Promise<{ alpha: number; beta: number; radius: number; frozen?: string }> {
        await page.goto(`${URL}?pathTime=${t}`, { waitUntil: "domcontentloaded" });
        await waitReady(page);
        return page.evaluate(() => {
            const d = document.getElementById("renderCanvas")!.dataset;
            return { alpha: Number(d.camAlpha), beta: Number(d.camBeta), radius: Number(d.camRadius), frozen: d.cameraPathFrozen };
        });
    }

    test("samples at t = 0, 5, 10, 15 s are deterministic and match the documented keyframes", async ({ page }) => {
        const p0 = await poseAt(page, 0);
        expect(p0.frozen).toBe("true");
        expect(near(p0.alpha, -0.8 * Math.PI)).toBeTruthy();
        expect(near(p0.beta, 65 * DEG)).toBeTruthy();

        const p5 = await poseAt(page, 5);
        expect(near(p5.alpha, -0.3 * Math.PI)).toBeTruthy();
        expect(near(p5.beta, 52.5 * DEG)).toBeTruthy();

        const p10 = await poseAt(page, 10);
        expect(near(p10.alpha, 0.2 * Math.PI)).toBeTruthy();
        expect(near(p10.beta, 40 * DEG)).toBeTruthy();

        const p15 = await poseAt(page, 15);
        expect(near(p15.alpha, 0.7 * Math.PI)).toBeTruthy();
        expect(near(p15.beta, 52.5 * DEG)).toBeTruthy();

        // Radius ratio is bounds-independent (2.4 : 0.75 = 3.2).
        expect(near(p0.radius / p10.radius, 3.2, 0.05)).toBeTruthy();

        // Repeatable: reloading the same time yields identical state.
        const p0b = await poseAt(page, 0);
        expect(p0b.alpha).toBe(p0.alpha);
        expect(p0b.beta).toBe(p0.beta);
        expect(p0b.radius).toBe(p0.radius);
    });
});

test.describe("MeshLoD demo — error state", () => {
    test("an unbundled model is rejected instead of silently substituting the statue", async ({ page }) => {
        await page.goto(`${URL}?model=lion`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("#renderCanvas")).toHaveAttribute("data-error", /lion.*not bundled/);
        await expect(page.locator("#demoError")).toHaveClass(/is-visible/);
    });

    test("an unrecoverable bootstrap error reaches data-error and reveals the banner", async ({ page }) => {
        await page.route("**/*.mlod", (route) => route.abort());
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const c = document.getElementById("renderCanvas");
                return c?.dataset.ready === "true" || !!c?.dataset.error;
            },
            { timeout: 60_000 }
        );
        const error = await page.evaluate(() => document.getElementById("renderCanvas")?.dataset.error);
        expect(error, "aborted .mlod bootstrap must surface an error").toBeTruthy();
        await expect(page.locator("#demoError")).toHaveClass(/is-visible/);
    });
});
