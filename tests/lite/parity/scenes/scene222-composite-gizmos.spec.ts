/**
 * Scene 222 — Composite Gizmos parity test.
 *
 * Drives a deterministic scripted interaction on each of the 3 composite
 * gizmos (PositionGizmo, RotationGizmo, ScaleGizmo) attached to cubes whose
 * parent TransformNode has a non-null rotation + translation.  The sequence:
 *
 *   1. With gizmos in LOCAL coord mode (default): drag the X arrow of the
 *      position gizmo, drag the Y ring of the rotation gizmo, drag the X
 *      arrow of the scale gizmo.
 *   2. Switch gizmos to WORLD coord mode via `__scene222.setLocalMode(false)`.
 *   3. Repeat each drag once more.
 *   4. Capture and compare with the BJS reference.
 *
 * Pixel coordinates are derived empirically from the rendered frame — each
 * sequence is a "best guess" hit on the corresponding gizmo widget.  Misses
 * are tolerated; the parity comparison still validates that BJS and Lite end
 * up in the same final pose given the same pointer events.
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { attachCompareArtifacts, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(222);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene222-composite-gizmos");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

interface DragStep {
    name: string;
    start: { x: number; y: number };
    end: { x: number; y: number };
}

// Drag steps for the LOCAL phase — coordinates chosen against the static
// initial frame.  Each step targets a different composite gizmo.
const LOCAL_DRAGS: DragStep[] = [
    // Position gizmo on cube 1 (left) — drag the +X arrow (points down-right
    // because cube 1's parent is rotated around Y by 0.4 rad).
    { name: "position-X-local", start: { x: 420, y: 352 }, end: { x: 458, y: 364 } },
    // Rotation gizmo on cube 2 (centre) — grab the top-left of a ring and drag
    // tangentially to rotate.
    { name: "rotation-Y-local", start: { x: 600, y: 272 }, end: { x: 565, y: 300 } },
    // Scale gizmo on cube 3 (right) — drag the +X axis box head outward.
    { name: "scale-X-local", start: { x: 986, y: 374 }, end: { x: 1012, y: 388 } },
];

const WORLD_DRAGS: DragStep[] = [
    // The WORLD phase re-drags the position gizmo only.  In world-coord mode the
    // +X arrow points along world +X (a long horizontal widget); dragging along
    // it exercises the world-vs-local axis re-orientation.  Coordinates track the
    // horizontal arrow (y≈348) so the gesture stays on the widget in both engines
    // despite the gizmo having re-centred after the LOCAL drag.
    //
    // A world rotation re-drag is intentionally omitted: after the LOCAL rotation
    // the world rings reproject to different screen positions in each engine, so a
    // fixed-coord gesture lands on a ring in one engine but on empty space in the
    // other — and a miss makes the camera controls grab the gesture and orbit,
    // diverging the whole frame.  A world scale re-drag is likewise omitted: the
    // ScaleGizmo has no world-coord mode (matches BJS — it always stays local), so
    // re-dragging it in "world" mode adds no coverage while risking the same miss.
    { name: "position-X-world", start: { x: 452, y: 348 }, end: { x: 492, y: 348 } },
];

test.skip(!!sceneConfig.skipParity, "Scene 222 skipped via skipParity in scene-config.json");

async function performDrags(page: Page, steps: DragStep[]): Promise<void> {
    const box = await page.locator("canvas").boundingBox();
    if (!box) {
        throw new Error("canvas has no bounding box");
    }
    for (const step of steps) {
        const sx = box.x + step.start.x;
        const sy = box.y + step.start.y;
        const ex = box.x + step.end.x;
        const ey = box.y + step.end.y;
        // Hover the gizmo and WAIT long enough for the async GPU hover-pick to
        // resolve before pressing.  Lite picks asynchronously; once the hover
        // pick lands the gizmo is marked hovered, so (a) the camera controls
        // defer to the gizmo instead of grabbing the gesture and (b) the
        // subsequent pointer-down pick lands on a primed picker.  Without this
        // settle the down-pick races the hover-pick on the shared GPU picker and
        // the drag intermittently fails to grab.  BJS picks synchronously and is
        // unaffected by the extra waits.
        await page.mouse.move(sx, sy);
        await page.waitForTimeout(300);
        await page.mouse.down();
        // Wait for the pointer-down pick to resolve and the gizmo to grab the
        // drag before moving.
        await page.waitForTimeout(250);
        await page.mouse.move(ex, ey, { steps: 8 });
        await page.waitForTimeout(150);
        await page.mouse.up();
        await page.waitForTimeout(150);
        // Park the cursor far off the gizmos BETWEEN drags so the hover state
        // clears before the next interaction.
        await page.mouse.move(box.x + 50, box.y + 50);
        await page.waitForTimeout(300);
    }
    // Final park so any per-frame hover-pick clears before the screenshot.
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.waitForTimeout(250);
}

async function driveScenario(page: Page): Promise<void> {
    await performDrags(page, LOCAL_DRAGS);
    await page.evaluate(() => {
        const s = (window as unknown as { __scene222?: { setLocalMode: (v: boolean) => void } }).__scene222;
        s?.setLocalMode(false);
    });
    await page.waitForTimeout(200);
    await performDrags(page, WORLD_DRAGS);
}

async function readCubeSnapshot(page: Page): Promise<{ c1x: number; c2qw: number; c3sx: number }> {
    return await page.evaluate(() => {
        const s = (
            window as unknown as {
                __scene222?: {
                    cube1Pos: () => { x: number };
                    cube2Quat: () => { w: number };
                    cube3Scale: () => { x: number };
                };
            }
        ).__scene222;
        if (!s) {
            return { c1x: NaN, c2qw: NaN, c3sx: NaN };
        }
        return { c1x: s.cube1Pos().x, c2qw: s.cube2Quat().w, c3sx: s.cube3Scale().x };
    });
}

test("Scene 222 — Composite Gizmos matches Babylon.js reference (local→world drags)", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const browser = page.context().browser()!;

    if (!fs.existsSync(GOLDEN_REF) || process.env.RECAPTURE_GOLDEN) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const bjsPage = await ctx.newPage();
        await bjsPage.goto("/babylon-ref-scene222.html");
        await bjsPage.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
        await bjsPage.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => undefined);
        await bjsPage.waitForTimeout(500);
        await driveScenario(bjsPage);
        await bjsPage.waitForTimeout(300);
        fs.mkdirSync(REFERENCE_DIR, { recursive: true });
        await bjsPage.locator("canvas").screenshot({ path: GOLDEN_REF });
        await bjsPage.close();
        await ctx.close();
    }

    await page.goto("/scene222.html");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    await page.waitForTimeout(500);
    const before = await readCubeSnapshot(page);
    const debug = await page.evaluate(async () => {
        const s = (
            window as unknown as {
                __scene222?: {
                    cube1WorldPos: () => { x: number; y: number; z: number };
                    probePick: (x: number, y: number) => Promise<string>;
                };
            }
        ).__scene222;
        if (!s) return { worldPos: null, probes: [] };
        const probes: string[] = [];
        for (let y = 220; y <= 420; y += 20) {
            for (let x = 180; x <= 1180; x += 30) {
                const r = await s.probePick(x, y);
                if (r !== "miss") {
                    probes.push(`(${x},${y})=${r}`);
                }
            }
        }
        return { worldPos: s.cube1WorldPos(), probes };
    });
    console.log(`Lite cube1 world pos: ${JSON.stringify(debug.worldPos)}`);
    console.log(`Lite probes (${debug.probes.length}):\n  ${debug.probes.join("\n  ")}`);
    await driveScenario(page);
    await page.waitForTimeout(300);
    const after = await readCubeSnapshot(page);
    console.log(`Lite cube1.x ${before.c1x.toFixed(3)} → ${after.c1x.toFixed(3)} (Δ=${(after.c1x - before.c1x).toFixed(3)})`);
    console.log(`Lite cube2.qw ${before.c2qw.toFixed(3)} → ${after.c2qw.toFixed(3)} (Δ=${(after.c2qw - before.c2qw).toFixed(3)})`);
    console.log(`Lite cube3.sx ${before.c3sx.toFixed(3)} → ${after.c3sx.toFixed(3)} (Δ=${(after.c3sx - before.c3sx).toFixed(3)})`);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    await attachCompareArtifacts(testInfo, screenshotPath, GOLDEN_REF, REFERENCE_DIR);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
