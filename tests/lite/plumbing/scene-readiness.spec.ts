import { test, expect } from "../parity/parity-fixtures";
import type { Request } from "@playwright/test";
import { waitForCanvasReady } from "../parity/compare-utils";

const scenes = [
    { id: 112, asset: "/models/FlightHelmetKTX/FlightHelmet.gltf" },
    { id: 121, asset: "/splats/Halo_Believe.splat" },
];

test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "wait" });
});

for (const scene of scenes) {
    for (const reference of [false, true]) {
        const label = `Scene ${scene.id} ${reference ? "BJS" : "Lite"}`;
        const url = `/${reference ? "babylon-ref-" : ""}scene${scene.id}.html`;

        test(`${label} starts without jsDelivr`, async ({ page }) => {
            test.setTimeout(180_000);
            const assetRequests: string[] = [];
            const pageErrors: string[] = [];
            const onRequest = (request: Request): void => {
                if (new URL(request.url()).pathname === scene.asset) {
                    assetRequests.push(request.url());
                }
            };
            const onError = (error: Error): void => {
                pageErrors.push(error.message);
            };
            page.on("request", onRequest);
            page.on("pageerror", onError);
            try {
                await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));
                await page.goto(url);
                await waitForCanvasReady(page, { timeout: 150_000, label });

                expect(assetRequests).toHaveLength(1);
                expect(new URL(assetRequests[0]!).origin).toBe(new URL(page.url()).origin);
                expect(pageErrors).toEqual([]);
            } finally {
                page.off("request", onRequest);
                page.off("pageerror", onError);
            }
        });

        if (scene.id === 112) {
            test(`${label} reports a failed KTX2 texture`, async ({ page }) => {
                await page.route("**/FlightHelmet_Materials_GlassPlasticMat_OcclusionRoughMetal.ktx2", (route) =>
                    route.fulfill({ status: 403, body: "Package size exceeded the configured limit of 50 MB" })
                );
                await page.goto(url);
                await expect(page.locator("canvas")).toHaveAttribute("data-error", /.+/, { timeout: 15_000 });
                await expect(waitForCanvasReady(page, { timeout: 1000, label })).rejects.toThrow(`${label} failed to initialize:`);
                await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
            });
        }

        test(`${label} reports asset failures instead of hanging`, async ({ page }) => {
            await page.route(`**${scene.asset}`, (route) => route.fulfill({ status: 503, body: "Scene fixture unavailable" }));
            await page.goto(url);
            await expect(page.locator("canvas")).toHaveAttribute("data-error", /.+/, { timeout: 15_000 });
            await expect(waitForCanvasReady(page, { timeout: 1000, label })).rejects.toThrow(`${label} failed to initialize:`);
            await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
        });
    }
}
