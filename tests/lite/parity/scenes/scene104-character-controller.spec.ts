/**
 * Scene 104 — Physics V2 (Havok PhysicsCharacterController) Parity Test
 *
 * Port of playgrounds #WO0H1U#165 (level walk) + #WO0H1U#169 (character-controller collision
 * detection). A PhysicsCharacterController capsule walks forward into a pyramid of dynamic boxes;
 * the controller's `onTriggerCollisionObservable` records every box it contacts. The test asserts:
 *
 *   1. The character trajectory matches between Lite and Babylon.js (canvas.dataset.charPos).
 *   2. The collision detection matches: the SET of colliders contacted is identical, and the first
 *      contact (collider name + rounded impulse position) is byte-identical. Read from
 *      canvas.dataset.collisions at the collision frame (55) — the deterministic window before the
 *      freely-simulated boxes diverge between the Lite and BJS Havok builds.
 *   3. The rendered frame matches (MAD) at a PRE-CONTACT frame (35). Once the boxes start moving
 *      (first contact ≈ frame 40) the two Havok builds compute slightly different box trajectories,
 *      so the visual frame diverges (MAD ≈ 0.17 by frame 55). The screenshot check therefore stays
 *      at frame 35 (boxes still at rest, MAD ≈ 0), while the collision-set check is the main new
 *      assertion. The scene104 maxMad ceiling (0.05) is left UNCHANGED.
 *
 * The character-trajectory + collision DATA is compared against the live Babylon.js reference each
 * run; the rendered frame is compared against a committed VISUAL golden (`babylon-ref-golden.png`)
 * captured at the pre-contact frame.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig, waitForCanvasReady } from "../compare-utils";

const sceneConfig = getSceneConfig(104);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene104-character-controller");
// Deterministic collision window: by frame 55 both engines have contacted {cube0,cube1,cube2}.
const COLLISION_FRAME = 55;
// Pre-contact frame for the visual check: boxes are still at rest (first contact ≈ frame 40).
const VISUAL_FRAME = 35;

test.skip(!!sceneConfig.skipParity, "Scene 104 skipped via skipParity in scene-config.json");

interface CollisionEvent {
    collider: string;
    impulsePosition: { x: number; y: number; z: number };
}

interface CaptureResult {
    charPos: string | undefined;
    collisions: string | undefined;
}

function distinctColliders(events: CollisionEvent[]): string[] {
    return [...new Set(events.map((e) => e.collider))].sort();
}

/** Load a scene page at the given capture frame; optionally screenshot the canvas. */
async function capture(page: Page, url: string, frame: number, label: string, screenshotPath?: string): Promise<CaptureResult> {
    await page.goto(`${url}?captureFrame=${frame}`);
    await waitForCanvasReady(page, { timeout: 50_000, label });
    await waitForCanvasReady(page, { timeout: 50_000, label: `${label} at frame ${frame}`, flag: "captureReady", pollMs: 100 });
    const data = await page.locator("canvas").evaluate((el) => ({
        charPos: (el as HTMLCanvasElement).dataset.charPos,
        collisions: (el as HTMLCanvasElement).dataset.collisions,
    }));
    if (screenshotPath) {
        await page.locator("canvas").screenshot({ path: screenshotPath });
    }
    return data;
}

test("Scene 104 — Character controller level walk + collision detection matches Babylon.js", async ({ page }) => {
    const browser = page.context().browser()!;
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });

    // ── Committed VISUAL golden at the pre-contact frame ──
    const goldenPath = await captureGolden(browser, { sceneId: 104, queryParams: `captureFrame=${VISUAL_FRAME}`, waitFlag: "captureReady" });

    // ── Babylon.js reference (live DATA) at the collision frame ──
    const bjsContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await bjsContext.newPage();
    const bjs = await capture(bjsPage, "/babylon-ref-scene104.html", COLLISION_FRAME, "Scene 104 BJS reference (collisions)");
    await bjsPage.close();
    await bjsContext.close();

    // ── Lite: collision frame (data) + pre-contact frame (visual) ──
    const lite = await capture(page, "/scene104.html", COLLISION_FRAME, "Scene 104 Lite (collisions)");
    const visualPath = path.join(REFERENCE_DIR, "test-actual.png");
    await capture(page, "/scene104.html", VISUAL_FRAME, "Scene 104 Lite (visual)", visualPath);

    // ── 1. Character trajectory ──
    console.log(`Scene 104 charPos — BJS: ${bjs.charPos}`);
    console.log(`Scene 104 charPos — Lite: ${lite.charPos}`);
    expect(lite.charPos, "Lite character position should be present").toBeTruthy();
    expect(bjs.charPos, "BJS character position should be present").toBeTruthy();
    const litePos = JSON.parse(lite.charPos!);
    const bjsPos = JSON.parse(bjs.charPos!);
    expect(Math.abs(litePos.x - bjsPos.x), "character x should be close").toBeLessThanOrEqual(0.3);
    expect(Math.abs(litePos.y - bjsPos.y), "character y should be close").toBeLessThanOrEqual(0.3);
    expect(Math.abs(litePos.z - bjsPos.z), "character z should be close").toBeLessThanOrEqual(0.3);

    // ── 2. Collision detection parity (PG #WO0H1U#169) ──
    console.log(`Scene 104 collisions — BJS: ${bjs.collisions}`);
    console.log(`Scene 104 collisions — Lite: ${lite.collisions}`);
    expect(bjs.collisions, "BJS collisions should be present").toBeTruthy();
    expect(lite.collisions, "Lite collisions should be present").toBeTruthy();
    const bjsCollisions = JSON.parse(bjs.collisions!) as CollisionEvent[];
    const liteCollisions = JSON.parse(lite.collisions!) as CollisionEvent[];
    expect(liteCollisions.length, "Lite should detect at least one collision").toBeGreaterThan(0);
    expect(bjsCollisions.length, "BJS should detect at least one collision").toBeGreaterThan(0);

    // The set of distinct colliders contacted must be identical.
    expect(distinctColliders(liteCollisions), "set of colliders contacted should match BJS").toEqual(distinctColliders(bjsCollisions));

    // The very first contact (collider name + rounded impulse position) is fully deterministic.
    const liteFirst = liteCollisions[0]!;
    const bjsFirst = bjsCollisions[0]!;
    expect(liteFirst.collider, "first contact collider name should match BJS").toBe(bjsFirst.collider);
    expect(liteFirst.impulsePosition, "first contact impulse position should match BJS").toEqual(bjsFirst.impulsePosition);

    // ── 3. Rendered frame parity at the pre-contact frame ──
    const full = compareImages(visualPath, goldenPath);
    console.log(`Full image at frame ${VISUAL_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
