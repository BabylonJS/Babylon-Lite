import { test, expect } from "../parity/parity-fixtures";
import { waitForCanvasReady } from "../parity/compare-utils";

const splatPath = "/splats/Halo_Believe.splat";

for (const sceneId of [121, 125, 126]) {
    for (const reference of [false, true]) {
        const label = `scene ${sceneId} ${reference ? "BJS" : "Lite"}`;
        const url = `/${reference ? "babylon-ref-" : ""}scene${sceneId}.html`;

        test(`${label} starts with the local splat and jsDelivr blocked`, async ({ page }) => {
            const splatRequests: string[] = [];
            const pageErrors: string[] = [];
            page.on("request", (request) => {
                if (request.url().includes("Halo_Believe.splat")) {
                    splatRequests.push(new URL(request.url()).pathname);
                }
            });
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));

            await page.goto(url);
            await expect.poll(() => splatRequests, { timeout: 15_000 }).toEqual([splatPath]);
            await waitForCanvasReady(page, { timeout: 45_000, label });

            expect(splatRequests).toEqual([splatPath]);
            expect(pageErrors).toEqual([]);
        });

        test(`${label} reports a failed local splat request`, async ({ page }) => {
            await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));
            await page.route(`**${splatPath}`, (route) => route.fulfill({ status: 503, body: "Splat fixture unavailable" }));

            await page.goto(url);
            await expect.poll(() => page.locator("canvas").getAttribute("data-error"), { timeout: 15_000 }).toBeTruthy();
            await expect(waitForCanvasReady(page, { timeout: 1000, label })).rejects.toThrow(`${label} failed to initialize:`);
            await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
        });
    }
}
