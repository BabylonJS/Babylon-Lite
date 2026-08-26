import { expect, test } from "playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FixtureManifest {
    fixtures: { id: string; name: string; file: string; variant: "full" | "shapes"; reference?: "babylon" | "lottie-web"; loop?: boolean; urlSource?: boolean }[];
}

const manifest = JSON.parse(readFileSync(resolve("tests/visual/fixtures/manifest.json"), "utf8")) as FixtureManifest;

for (const fixture of manifest.fixtures) {
    test(fixture.name, async ({ page }) => {
        const player = process.env.LOTTIE_VISUAL_MODE === "reference" ? "reference" : fixture.variant;
        await page.goto(
            `/?player=${player}&fixture=${fixture.file}&reference=${fixture.reference ?? "babylon"}&loop=${fixture.loop ?? true}&urlSource=${fixture.urlSource ?? false}`
        );
        await page.waitForFunction(() => {
            const stage = document.getElementById("stage");
            const state = stage?.dataset.state;
            if (state === "error") {
                throw new Error(stage?.dataset.errorMessage || "Lottie player failed");
            }
            return state === "ready";
        });
        await page.waitForTimeout(250);
        // The Babylon sprite reference and stencil renderer differ at some antialiased edge
        // samples. Keep the perceptual threshold low and cap all material differences to 1%.
        await expect(page.locator("#stage canvas")).toHaveScreenshot(`${fixture.id}.png`, {
            animations: "disabled",
            maxDiffPixelRatio: 0.01,
            threshold: 0.02,
        });
    });
}

test("Missing image invokes onError", async ({ page }) => {
    await page.goto("/?player=full&fixture=embedded-image.json&missingImage=true");
    await page.waitForFunction(() => document.getElementById("stage")?.dataset.state === "error");
    await expect(page.locator("#stage canvas")).toHaveCount(0);
});
