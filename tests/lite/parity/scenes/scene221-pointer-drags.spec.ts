/**
 * Scene 221 — Pointer Drags parity test.
 *
 * 1. Loads both BJS reference and Lite scene 221 (separate browser contexts).
 * 2. Drives the same deterministic mouse-drag sequence on each page using
 *    Playwright's real pointer-event dispatcher (so `offsetX/Y` and other
 *    derived fields are correctly populated for both engines' pickers).
 * 3. Compares the post-drag rendered frame against the captured golden.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(221);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene221-pointer-drags");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

// Drag sequences — pixel coordinates against the 1280×720 canvas, chosen
// against the static rendered frame.  Each entry drives one gizmo so the
// post-test pose exercises axis drag, plane rotation, plane drag, and axis
// scale.
const DRAG_SEQUENCES: { name: string; start: { x: number; y: number }; end: { x: number; y: number } }[] = [
    // Axis-drag arrow on cube 1 (red, +X axis) → slides cube 1 right.
    { name: "axisDrag-X", start: { x: 430, y: 330 }, end: { x: 510, y: 330 } },
    // Plane-rotation ring on cube 2 (green, Y normal) — grab a point on the
    // ring and drag through the camera-projected ellipse to rotate around Y.
    { name: "planeRotation-Y", start: { x: 600, y: 300 }, end: { x: 540, y: 360 } },
    // Plane-drag card on cube 3 (blue, Y normal) → slides cube 3 along XZ.
    { name: "planeDrag-Y", start: { x: 720, y: 320 }, end: { x: 780, y: 320 } },
    // Axis-scale tail on cube 4 (yellow, +Y axis) — drag the vertical scale
    // line upward to grow the cube along Y.
    { name: "axisScale-Y", start: { x: 920, y: 280 }, end: { x: 920, y: 230 } },
];

test.skip(!!sceneConfig.skipParity, "Scene 221 skipped via skipParity in scene-config.json");

async function performDragSequences(page: Page): Promise<void> {
    const box = await page.locator("canvas").boundingBox();
    if (!box) {
        throw new Error("canvas has no bounding box");
    }
    for (const seq of DRAG_SEQUENCES) {
        const sx = box.x + seq.start.x;
        const sy = box.y + seq.start.y;
        const ex = box.x + seq.end.x;
        const ey = box.y + seq.end.y;
        // Hover the gizmo and WAIT long enough for Lite's async GPU hover-pick to
        // resolve before pressing.  Once the hover pick lands the gizmo is marked
        // hovered, so the subsequent pointer-down pick lands on a primed picker
        // instead of racing the hover-pick on the shared GPU picker (which made
        // the plane-rotation drag intermittently miss → cube stayed un-rotated,
        // diverging from the BJS golden).  BJS picks synchronously and is
        // unaffected by the extra waits.
        await page.mouse.move(sx, sy);
        await page.waitForTimeout(300);
        await page.mouse.down();
        await page.waitForTimeout(250);
        await page.mouse.move(ex, ey, { steps: 8 });
        await page.waitForTimeout(150);
        await page.mouse.up();
        // Longer post-up wait so BJS's AxisScaleGizmo `resetGizmoMesh` (which
        // restores arrowMesh.position + arrowTail.scaling after drag) commits
        // before the next drag interrupts it.
        await page.waitForTimeout(160);
        // Park the cursor far off the gizmos BETWEEN drags so the hover state
        // clears before the next interaction.
        await page.mouse.move(box.x + 50, box.y + 50);
        await page.waitForTimeout(200);
    }
    // Park the cursor far off the gizmos so BJS's per-frame hover-pick clears
    // the hover material before the screenshot, then wait several frames so
    // both engines settle to their post-drag rest pose.  BJS AxisScaleGizmo
    // briefly inflates the visual mesh during a drag and resets it on drag
    // end; the longer settle window gives the reset and any subsequent
    // worldMatrix recomputations time to flush before capture.
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.waitForTimeout(800);
}

async function readCubeSnapshot(page: Page): Promise<{ c1x: number; c2qw: number; c3x: number; c4sy: number }> {
    return await page.evaluate(() => {
        const s = (
            window as unknown as {
                __scene221?: {
                    cube1Pos: () => { x: number };
                    cube2Quat: () => { w: number };
                    cube3Pos: () => { x: number };
                    cube4Scale: () => { y: number };
                };
            }
        ).__scene221;
        if (!s) {
            return { c1x: NaN, c2qw: NaN, c3x: NaN, c4sy: NaN };
        }
        return { c1x: s.cube1Pos().x, c2qw: s.cube2Quat().w, c3x: s.cube3Pos().x, c4sy: s.cube4Scale().y };
    });
}

const ROTATION_GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-rotation-midDrag.png");

async function performRotationMidDrag(page: Page): Promise<void> {
    const box = await page.locator("canvas").boundingBox();
    if (!box) {
        throw new Error("canvas has no bounding box");
    }
    // Grab the plane-rotation ring and drag through ~half the ellipse without
    // releasing — at this point the "camembert" sector visual is visible at the
    // gizmo centre in both engines.
    const sx = box.x + 600;
    const sy = box.y + 300;
    const ex = box.x + 540;
    const ey = box.y + 360;
    // Hover-settle so Lite's async GPU hover-pick resolves before pressing —
    // otherwise the down-pick races it and the rotation drag misses, leaving the
    // cube un-rotated and the camembert hidden (BJS picks synchronously).
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.move(ex, ey, { steps: 8 });
    // Hold (no mouse.up) so the rotation display plane stays enabled at
    // screenshot time.  A couple of animation frames of wait so the GPU has
    // committed the latest uniform values.
    await page.waitForTimeout(200);
}

test("Scene 221 — Rotation gizmo camembert visible mid-drag", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const browser = page.context().browser()!;

    if (!fs.existsSync(ROTATION_GOLDEN_REF) || process.env.RECAPTURE_GOLDEN) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const bjsPage = await ctx.newPage();
        await bjsPage.goto("/babylon-ref-scene221.html");
        await bjsPage.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await bjsPage.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => undefined);
        await bjsPage.waitForTimeout(500);
        await performRotationMidDrag(bjsPage);
        await bjsPage.locator("canvas").screenshot({ path: ROTATION_GOLDEN_REF });
        await bjsPage.mouse.up().catch(() => undefined);
        await bjsPage.close();
        await ctx.close();
    }

    await page.goto("/scene221.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);
    await performRotationMidDrag(page);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual-rotation-midDrag.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });
    await page.mouse.up().catch(() => undefined);

    const full = compareImages(screenshotPath, ROTATION_GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, ROTATION_GOLDEN_REF, REFERENCE_DIR);
    console.log(`Mid-rotation MAD=${full.mad.toFixed(3)}`);

    // Same MAD ceiling as the main test — the camembert covers ~15% of the
    // cube-2 area and any deviation in its colour/alpha will dominate the
    // per-pixel diff if the shader isn't matching.
    expect(full.mad, `Mid-rotation MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});

test("Scene 221 — Pointer Drags matches Babylon.js reference (post scripted drag)", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const browser = page.context().browser()!;

    // ── Capture golden by driving the BJS reference page through the drag set ──
    if (!fs.existsSync(GOLDEN_REF) || process.env.RECAPTURE_GOLDEN) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const bjsPage = await ctx.newPage();
        await bjsPage.goto("/babylon-ref-scene221.html");
        await bjsPage.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await bjsPage.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => undefined);
        await bjsPage.waitForTimeout(500);
        await performDragSequences(bjsPage);
        await bjsPage.waitForTimeout(200);
        fs.mkdirSync(REFERENCE_DIR, { recursive: true });
        await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });
        await bjsPage.close();
        await ctx.close();
    }

    // ── Drive Lite through the same drag set and capture ──
    await page.goto("/scene221.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);
    const before = await readCubeSnapshot(page);
    await performDragSequences(page);
    await page.waitForTimeout(200);
    const after = await readCubeSnapshot(page);
    console.log(`Lite cube1.x ${before.c1x.toFixed(3)} → ${after.c1x.toFixed(3)} (Δ=${(after.c1x - before.c1x).toFixed(3)})`);
    console.log(`Lite cube2.qw ${before.c2qw.toFixed(3)} → ${after.c2qw.toFixed(3)} (Δ=${(after.c2qw - before.c2qw).toFixed(3)})`);
    console.log(`Lite cube3.x ${before.c3x.toFixed(3)} → ${after.c3x.toFixed(3)} (Δ=${(after.c3x - before.c3x).toFixed(3)})`);
    console.log(`Lite cube4.sy ${before.c4sy.toFixed(3)} → ${after.c4sy.toFixed(3)} (Δ=${(after.c4sy - before.c4sy).toFixed(3)})`);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
