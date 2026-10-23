import { test, expect } from "../parity/parity-fixtures";
import { waitForCanvasReady } from "../parity/compare-utils";

const modelRoot = "https://raw.githubusercontent.com/KhronosGroupArchives/glTF-Sample-Models/d7a3cc8e51d7c573771ae77a57f16b0662a905c6/2.0/MosquitoInAmber/glTF/";
const modelFiles = [
    "MosquitoInAmber.gltf",
    "MosquitoInAmber.bin",
    "MosquitoInAmber0.jpg",
    "MosquitoInAmber1.png",
    "MosquitoInAmber2.png",
    "MosquitoInAmber3.jpg",
    "MosquitoInAmber4.jpg",
];

for (const reference of [false, true]) {
    const label = `scene 176 ${reference ? "BJS" : "Lite"}`;
    const url = `/${reference ? "babylon-ref-" : ""}scene176.html`;

    test(`${label} starts from the pinned model with jsDelivr blocked`, async ({ page }) => {
        const modelRequests = new Set<string>();
        const pageErrors: string[] = [];
        page.on("request", (request) => {
            if (request.url().startsWith(modelRoot)) {
                modelRequests.add(request.url().slice(modelRoot.length));
            }
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));

        await page.goto(url);
        await waitForCanvasReady(page, { timeout: 45_000, label });

        expect([...modelRequests].sort()).toEqual([...modelFiles].sort());
        expect(pageErrors).toEqual([]);
        await expect(page.locator("canvas")).toHaveAttribute("data-cam-fov", "0.8");
    });

    test(`${label} reports a failed model request without claiming readiness`, async ({ page }) => {
        await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort("blockedbyclient"));
        await page.route(`${modelRoot}MosquitoInAmber.gltf`, (route) => route.fulfill({ status: 503, body: "Model fixture unavailable" }));

        await page.goto(url);
        await expect.poll(() => page.locator("canvas").getAttribute("data-error"), { timeout: 15_000 }).toBeTruthy();
        await expect(waitForCanvasReady(page, { timeout: 1000, label })).rejects.toThrow(`${label} failed to initialize:`);
        await expect(page.locator("canvas")).not.toHaveAttribute("data-ready", "true");
    });
}
