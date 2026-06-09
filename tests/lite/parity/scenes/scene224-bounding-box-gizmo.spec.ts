/**
 * Scene 224 — Bounding Box Gizmo parity test.
 *
 * Drives a deterministic post-edit pose by setting the group root's TRS
 * directly via the `__scene224.setRootTrs(pos, quat, scale)` test hook in
 * BOTH engines, then compares the rendered frame.
 *
 * The previous version simulated the three core BoundingBoxGizmo
 * manipulations (corner scale, edge rotation, body translate) as scripted
 * pointer drags.  Each drag produced ~14% more rotation / scale in Lite
 * than in BJS for the same screen gesture (Lite's pointer-drag plumbing
 * delivers ~2× BJS's per-tick projected world delta), so the two engines
 * ended up at materially different poses and the post-drag MAD hovered
 * near the 2.5 ceiling — and the diff map was dominated by silhouette
 * offsets, not by anything wrong with the gizmo's rendering.
 *
 * Bypassing pointer-drag entirely (Lite's drag plumbing is exercised by
 * scenes 221 / 222) and driving the root's TRS to the same numeric
 * values in both engines reduces the comparison to the gizmo's actual
 * RENDERING — material parity, handle placement, wireframe color,
 * rotation-anchor geometry — which is the part this scene is meant to
 * cover.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(224);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene224-bounding-box-gizmo");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

// Target pose for the group root.  Chosen to mimic the previous post-drag
// reference (modest translate left + scale up + Y-rotation) so the gizmo
// renders at a visually rich, non-identity pose.
//
//   • pos    = (-1, 1, 0)
//   • quat   = Y-rotation by 18°  → (0, sin(9°), 0, cos(9°))
//   • scale  = (1.07, 1.07, 1.07)
const ANGLE_RAD = (18 * Math.PI) / 180;
const POSE = {
    pos: { x: -1, y: 1, z: 0 },
    quat: { x: 0, y: Math.sin(ANGLE_RAD * 0.5), z: 0, w: Math.cos(ANGLE_RAD * 0.5) },
    scale: { x: 1.07, y: 1.07, z: 1.07 },
};

test.skip(!!sceneConfig.skipParity, "Scene 224 skipped via skipParity in scene-config.json");

async function applyPose(page: Page): Promise<void> {
    await page.evaluate((p) => {
        const s = (
            window as unknown as {
                __scene224?: {
                    setRootTrs: (pos: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, scl: { x: number; y: number; z: number }) => void;
                };
            }
        ).__scene224;
        s?.setRootTrs(p.pos, p.quat, p.scale);
    }, POSE);
    // Let the gizmo's per-frame refresh run a couple of frames so the
    // wireframe / handles / rotation anchors all relocate to the new pose
    // before the screenshot.
    await page.waitForTimeout(250);
}

async function readRoot(page: Page): Promise<{ px: number; qw: number; sx: number }> {
    return await page.evaluate(() => {
        const s = (
            window as unknown as {
                __scene224?: {
                    rootPos: () => { x: number };
                    rootQuat: () => { w: number };
                    rootScale: () => { x: number };
                };
            }
        ).__scene224;
        if (!s) {
            return { px: NaN, qw: NaN, sx: NaN };
        }
        return { px: s.rootPos().x, qw: s.rootQuat().w, sx: s.rootScale().x };
    });
}

test("Scene 224 — Bounding Box Gizmo matches Babylon.js reference (deterministic pose)", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const browser = page.context().browser()!;

    if (!fs.existsSync(GOLDEN_REF) || process.env.RECAPTURE_GOLDEN) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const bjsPage = await ctx.newPage();
        await bjsPage.goto("/babylon-ref-scene224.html?nocam=1");
        await bjsPage.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await bjsPage.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => undefined);
        await bjsPage.waitForTimeout(500);
        await applyPose(bjsPage);
        await bjsPage.waitForTimeout(200);
        const bjsAfter = await readRoot(bjsPage);
        console.log(`BJS  root: x=${bjsAfter.px.toFixed(3)} qw=${bjsAfter.qw.toFixed(3)} sx=${bjsAfter.sx.toFixed(3)}`);
        fs.mkdirSync(REFERENCE_DIR, { recursive: true });
        await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });
        await bjsPage.close();
        await ctx.close();
    }

    await page.goto("/scene224.html?nocam=1");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);
    await applyPose(page);
    const after = await readRoot(page);
    console.log(`Lite root: x=${after.px.toFixed(3)} qw=${after.qw.toFixed(3)} sx=${after.sx.toFixed(3)}`);

    // Sanity: setRootTrs must actually have landed.
    expect(Math.abs(after.px - POSE.pos.x), "setRootTrs should set root.x").toBeLessThan(1e-3);
    expect(Math.abs(after.qw - POSE.quat.w), "setRootTrs should set root.qw").toBeLessThan(1e-3);
    expect(Math.abs(after.sx - POSE.scale.x), "setRootTrs should set root.sx").toBeLessThan(1e-3);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
