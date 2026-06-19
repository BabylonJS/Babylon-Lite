/**
 * Scene 105 — Physics V2 (Havok PhysicsCharacterController) + Moving Platform Parity Test
 *
 * Port of playground #WO0H1U#166: scene104 (level walk) PLUS a kinematic (ANIMATED) moving platform
 * and a different start camera (5,5,-5). A PhysicsCharacterController capsule walks steered toward the
 * moving platform at (-4,-12); on the way it passes through a "gate" of three dynamic boxes, and the
 * controller's `onTriggerCollisionObservable` records every box it contacts. The test asserts:
 *
 *   1. The character trajectory matches between Lite and Babylon.js (canvas.dataset.charPos), within
 *      tolerance (the dynamic boxes deflect the character slightly differently once disturbed).
 *   2. The collision detection matches: the SET of colliders contacted is identical, the first contact
 *      collider NAME is identical, and the first-contact impulse position matches within a small
 *      tolerance. Both scenes use the same @babylonjs/havok wasm, so the character path is bit-identical
 *      until first contact; the residual impulse-position difference comes from the Lite TypeScript
 *      character-controller port computing the contact manifold point slightly differently from BJS.
 *      We therefore assert the genuinely-deterministic subset (set + first-contact name) strictly and
 *      the impulse position within tolerance, as mandated by the determinism caveat.
 *   3. The rendered frame matches (MAD) at a PRE-CONTACT frame (55). The moving platform is animated
 *      count-based from the fixed physics step, so it is deterministic and does not hurt MAD; the
 *      dynamic boxes are still at rest at frame 55 (first contact ≈ frame 70). Collisions + charPos are
 *      read at the later collision frame (105), where the character has reached the platform.
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

const sceneConfig = getSceneConfig(105);
const REFERENCE_DIR = path.resolve(__dirname, "../../../../reference/lite/scene105-moving-platform");
// Collision window: by frame 105 both engines have contacted {obstacle0,obstacle1,obstacle2} and the
// character has reached the platform footprint.
const COLLISION_FRAME = 105;
// Pre-contact frame for the visual check: the boxes are still at rest (first contact ≈ frame 70).
const VISUAL_FRAME = 55;
// Tolerance on the first-contact impulse position (the two character-controller ports compute the
// contact manifold point slightly differently even from an identical character/box configuration).
const IMPULSE_TOL = 0.05;

test.skip(!!sceneConfig.skipParity, "Scene 105 skipped via skipParity in scene-config.json");

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

test("Scene 105 — Character controller + moving platform matches Babylon.js", async ({ page }) => {
    const browser = page.context().browser()!;
    fs.mkdirSync(REFERENCE_DIR, { recursive: true });

    // ── Committed VISUAL golden at the pre-contact frame ──
    const goldenPath = await captureGolden(browser, { sceneId: 105, queryParams: `captureFrame=${VISUAL_FRAME}`, waitFlag: "captureReady" });

    // ── Babylon.js reference (live DATA) at the collision frame ──
    const bjsContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bjsPage = await bjsContext.newPage();
    const bjs = await capture(bjsPage, "/babylon-ref-scene105.html", COLLISION_FRAME, "Scene 105 BJS reference (collisions)");
    await bjsPage.close();
    await bjsContext.close();

    // ── Lite: collision frame (data) + pre-contact frame (visual) ──
    const lite = await capture(page, "/scene105.html", COLLISION_FRAME, "Scene 105 Lite (collisions)");
    const visualPath = path.join(REFERENCE_DIR, "test-actual.png");
    await capture(page, "/scene105.html", VISUAL_FRAME, "Scene 105 Lite (visual)", visualPath);

    // ── 1. Character trajectory ──
    console.log(`Scene 105 charPos — BJS: ${bjs.charPos}`);
    console.log(`Scene 105 charPos — Lite: ${lite.charPos}`);
    expect(lite.charPos, "Lite character position should be present").toBeTruthy();
    expect(bjs.charPos, "BJS character position should be present").toBeTruthy();
    const litePos = JSON.parse(lite.charPos!);
    const bjsPos = JSON.parse(bjs.charPos!);
    expect(Math.abs(litePos.x - bjsPos.x), "character x should be close").toBeLessThanOrEqual(0.3);
    expect(Math.abs(litePos.y - bjsPos.y), "character y should be close").toBeLessThanOrEqual(0.3);
    expect(Math.abs(litePos.z - bjsPos.z), "character z should be close").toBeLessThanOrEqual(0.3);

    // ── 2. Collision detection parity ──
    console.log(`Scene 105 collisions — BJS: ${bjs.collisions}`);
    console.log(`Scene 105 collisions — Lite: ${lite.collisions}`);
    expect(bjs.collisions, "BJS collisions should be present").toBeTruthy();
    expect(lite.collisions, "Lite collisions should be present").toBeTruthy();
    const bjsCollisions = JSON.parse(bjs.collisions!) as CollisionEvent[];
    const liteCollisions = JSON.parse(lite.collisions!) as CollisionEvent[];
    expect(liteCollisions.length, "Lite should detect at least one collision").toBeGreaterThan(0);
    expect(bjsCollisions.length, "BJS should detect at least one collision").toBeGreaterThan(0);

    // The set of distinct colliders contacted must be identical.
    expect(distinctColliders(liteCollisions), "set of colliders contacted should match BJS").toEqual(distinctColliders(bjsCollisions));

    // The very first contact collider name is fully deterministic; its impulse position matches within tolerance.
    const liteFirst = liteCollisions[0]!;
    const bjsFirst = bjsCollisions[0]!;
    expect(liteFirst.collider, "first contact collider name should match BJS").toBe(bjsFirst.collider);
    expect(Math.abs(liteFirst.impulsePosition.x - bjsFirst.impulsePosition.x), "first contact impulse x").toBeLessThanOrEqual(IMPULSE_TOL);
    expect(Math.abs(liteFirst.impulsePosition.y - bjsFirst.impulsePosition.y), "first contact impulse y").toBeLessThanOrEqual(IMPULSE_TOL);
    expect(Math.abs(liteFirst.impulsePosition.z - bjsFirst.impulsePosition.z), "first contact impulse z").toBeLessThanOrEqual(IMPULSE_TOL);

    // ── 3. Rendered frame parity at the pre-contact frame ──
    const full = compareImages(visualPath, goldenPath);
    console.log(`Full image at frame ${VISUAL_FRAME} (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);
    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`).toBeLessThanOrEqual(sceneConfig.maxMad);
});
