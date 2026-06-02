/**
 * Scene 140 — Scene 66 NME variant with final-alpha discard on shadow casters.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";
import { PNG } from "pngjs";
import { attachCompareArtifacts, captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(140);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene140-nme-pcf-alpha-discard-shadows");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");
const MORPH_SHADOW_CLIPS = [
    { x: 430, y: 330, width: 120, height: 80 },
    { x: 500, y: 360, width: 120, height: 80 },
    { x: 560, y: 390, width: 120, height: 80 },
    { x: 620, y: 390, width: 120, height: 80 },
    { x: 700, y: 385, width: 120, height: 80 },
] as const;
const CUBE_SHADOW_SEARCH = { x: 350, y: 460, width: 600, height: 180, tile: 48, step: 16 } as const;

function screenshotRegionMad(a: Buffer, b: Buffer, region: { x: number; y: number; width: number; height: number }): number {
    const actual = PNG.sync.read(a);
    const reference = PNG.sync.read(b);
    const x1 = Math.min(region.x + region.width, actual.width, reference.width);
    const y1 = Math.min(region.y + region.height, actual.height, reference.height);
    let sumDiff = 0;
    let pixels = 0;

    for (let y = region.y; y < y1; y++) {
        for (let x = region.x; x < x1; x++) {
            const ai = (y * actual.width + x) * 4;
            const ri = (y * reference.width + x) * 4;
            sumDiff +=
                (Math.abs(actual.data[ai]! - reference.data[ri]!) +
                    Math.abs(actual.data[ai + 1]! - reference.data[ri + 1]!) +
                    Math.abs(actual.data[ai + 2]! - reference.data[ri + 2]!)) /
                3;
            pixels++;
        }
    }

    return sumDiff / pixels;
}

function maxGroundShadowTileMad(a: Buffer, b: Buffer): { mad: number; region: string } {
    const actual = PNG.sync.read(a);
    const reference = PNG.sync.read(b);
    const regionMad = (region: { x: number; y: number; width: number; height: number }): number => {
        const x1 = Math.min(region.x + region.width, actual.width, reference.width);
        const y1 = Math.min(region.y + region.height, actual.height, reference.height);
        let sumDiff = 0;
        let pixels = 0;
        for (let y = region.y; y < y1; y++) {
            for (let x = region.x; x < x1; x++) {
                const ai = (y * actual.width + x) * 4;
                const ri = (y * reference.width + x) * 4;
                sumDiff +=
                    (Math.abs(actual.data[ai]! - reference.data[ri]!) +
                        Math.abs(actual.data[ai + 1]! - reference.data[ri + 1]!) +
                        Math.abs(actual.data[ai + 2]! - reference.data[ri + 2]!)) /
                    3;
                pixels++;
            }
        }
        return sumDiff / pixels;
    };
    let bestMad = 0;
    let bestRegion = "";
    for (let y = CUBE_SHADOW_SEARCH.y; y <= CUBE_SHADOW_SEARCH.y + CUBE_SHADOW_SEARCH.height - CUBE_SHADOW_SEARCH.tile; y += CUBE_SHADOW_SEARCH.step) {
        for (let x = CUBE_SHADOW_SEARCH.x; x <= CUBE_SHADOW_SEARCH.x + CUBE_SHADOW_SEARCH.width - CUBE_SHADOW_SEARCH.tile; x += CUBE_SHADOW_SEARCH.step) {
            const mad = regionMad({ x, y, width: CUBE_SHADOW_SEARCH.tile, height: CUBE_SHADOW_SEARCH.tile });
            if (mad > bestMad) {
                bestMad = mad;
                bestRegion = `${x},${y},${CUBE_SHADOW_SEARCH.tile},${CUBE_SHADOW_SEARCH.tile}`;
            }
        }
    }
    return { mad: bestMad, region: bestRegion };
}

test.skip(!!sceneConfig.skipParity, "Scene 140 skipped via skipParity in scene-config.json");

test("Scene 140 — NME PCF alpha discard shadows match Babylon.js reference", async ({ page }, testInfo) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 140, queryParams: "freeze=1", timeout: 120_000 });

    await page.goto("/scene140.html?freeze=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 140 — morphing sphere updates its PCF shadow on the ground", async ({ page }) => {
    await page.goto("/scene140.html?manualMorph=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });

    const canvas = page.locator("canvas");
    const before = await canvas.screenshot();
    await page.evaluate(() => (globalThis as { __scene140SetMorphWeight?: (value: number) => void }).__scene140SetMorphWeight?.(1));
    await page.waitForTimeout(500);
    const after = await canvas.screenshot();

    const shadowMad = Math.max(...MORPH_SHADOW_CLIPS.map((clip) => screenshotRegionMad(after, before, clip)));
    const strongestTile = maxGroundShadowTileMad(after, before);
    console.log(`Morph ground-shadow region MAD=${shadowMad.toFixed(3)}, max tile MAD=${strongestTile.mad.toFixed(3)} at ${strongestTile.region}`);

    expect(
        Math.max(shadowMad, strongestTile.mad),
        "Ground/shadow-only region should change as morph weights progress; a static region means the PCF shadow map stayed stale"
    ).toBeGreaterThan(3.75);
});

test("Scene 140 — cube final-alpha discard cuts holes in its PCF ground shadow", async ({ page }) => {
    await page.goto("/scene140.html?freeze=1&shadowHoleProbe=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    const cutoutCaster = await page.locator("canvas").screenshot();

    await page.goto("/scene140.html?freeze=1&shadowHoleProbe=1&solidShadowCaster=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    const solidCaster = await page.locator("canvas").screenshot();

    const strongestTile = maxGroundShadowTileMad(cutoutCaster, solidCaster);
    console.log(`Cube cutout-vs-solid max ground-shadow tile MAD=${strongestTile.mad.toFixed(3)} at ${strongestTile.region}`);

    expect(
        strongestTile.mad,
        "The NME cube caster should differ from an opaque caster on the ground-shadow region because final-alpha discard cuts holes into the PCF depth map"
    ).toBeGreaterThan(1.0);
});

test("Scene 140 — BJS reference cube final-alpha discard cuts holes in its PCF ground shadow", async ({ page }) => {
    await page.goto("/babylon-ref-scene140.html?freeze=1&shadowHoleProbe=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    const cutoutCaster = await page.locator("canvas").screenshot();

    await page.goto("/babylon-ref-scene140.html?freeze=1&shadowHoleProbe=1&solidShadowCaster=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 120_000 });
    const solidCaster = await page.locator("canvas").screenshot();

    const strongestTile = maxGroundShadowTileMad(cutoutCaster, solidCaster);
    console.log(`BJS cube cutout-vs-solid max ground-shadow tile MAD=${strongestTile.mad.toFixed(3)} at ${strongestTile.region}`);

    expect(
        strongestTile.mad,
        "The BJS reference NME cube caster must differ from an opaque caster on the ground-shadow region; otherwise the reference shadow pass is not using ShadowDepthWrapper for final-alpha discard"
    ).toBeGreaterThan(1.0);
});
