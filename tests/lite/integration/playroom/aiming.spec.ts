import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { installWebGpuRenderBundleObserver } from "./webgpu-render-bundle-observer.js";
import type { ObservedBundleDraw } from "./webgpu-render-bundle-observer.js";

const labTestPort = Number(process.env.LAB_TEST_PORT ?? 5179);
const demoUrl = `http://127.0.0.1:${labTestPort}/lite/demo-playroom.html`;
const AIMING_INDEX_COUNT = 180;

function findLastAimingDraw(draws: readonly ObservedBundleDraw[]): ObservedBundleDraw {
    for (let index = draws.length - 1; index >= 0; index--) {
        if (draws[index]!.indexCount === AIMING_INDEX_COUNT) {
            return draws[index]!;
        }
    }
    throw new Error("The aiming ribbon was not drawn");
}

function changedRibbonPixels(visiblePng: Buffer, suppressedPng: Buffer): { changed: number; translucentRed: number } {
    const visible = PNG.sync.read(visiblePng);
    const suppressed = PNG.sync.read(suppressedPng);
    let changed = 0;
    let translucentRed = 0;
    for (let offset = 0; offset < visible.data.length; offset += 4) {
        const redDelta = visible.data[offset]! - suppressed.data[offset]!;
        const greenDelta = Math.abs(visible.data[offset + 1]! - suppressed.data[offset + 1]!);
        const blueDelta = Math.abs(visible.data[offset + 2]! - suppressed.data[offset + 2]!);
        if (Math.max(Math.abs(redDelta), greenDelta, blueDelta) > 10) {
            changed++;
        }
        if (
            redDelta > 10 &&
            suppressed.data[offset + 1]! > 20 &&
            suppressed.data[offset + 2]! > 20 &&
            visible.data[offset + 1]! > suppressed.data[offset + 1]! * 0.5 &&
            visible.data[offset + 2]! > suppressed.data[offset + 2]! * 0.5
        ) {
            translucentRed++;
        }
    }
    return { changed, translucentRed };
}

test("renders the source-shaped translucent aiming ribbon only while aiming", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(installWebGpuRenderBundleObserver);
    await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.ready === "true", undefined, { timeout: 60_000 });

    expect(
        await page.evaluate((indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length, AIMING_INDEX_COUNT)
    ).toBe(0);
    await page.locator("#playroom-startup-action").click();
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.gamePhase === "aiming");
    await page.waitForFunction((indexCount) => window.__playroomRenderBundleObservation?.().directDraws.some((draw) => draw.indexCount === indexCount), AIMING_INDEX_COUNT);
    await page.waitForTimeout(500);

    const observation = await page.evaluate(() => window.__playroomRenderBundleObservation?.());
    expect(observation).toBeDefined();
    const draw = findLastAimingDraw(observation!.directDraws);
    const pipeline = observation!.pipelines.find((candidate) => candidate.id === draw.pipelineId)!;
    expect(pipeline.primitive).toMatchObject({ topology: "triangle-list", cullMode: "none" });
    expect(pipeline.depthStencil).toMatchObject({ depthCompare: "greater-equal", depthWriteEnabled: false });
    expect(pipeline.blend).toEqual({
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
    });

    const aimingUniforms = observation!.createdBuffers
        .filter((buffer) => buffer.label === "node-ubo" && buffer.size === 48)
        .map((buffer) => {
            const bytes = Buffer.from(buffer.dataBase64, "base64");
            return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
        })
        .find((values) => Math.abs(values[3]! - 0.625) < 1e-6)!;
    expect(aimingUniforms[0]).toBeGreaterThan(0);
    expect(aimingUniforms.slice(1, 4)).toEqual([0.75, 1.25, 0.625]);
    expect(aimingUniforms[4]).toBeCloseTo(Math.PI, 5);
    expect(aimingUniforms[5]).toBeCloseTo(0.4, 6);
    expect(aimingUniforms[6]).toBeCloseTo(-0.1, 6);
    expect(aimingUniforms[7]).toBeCloseTo(0.25, 6);
    expect(aimingUniforms.slice(8, 10)).toEqual([12, 1]);

    const positionBufferId = draw.vertexBuffers.map((buffer) => buffer.bufferId).find((id) => observation!.buffers.find((buffer) => buffer.id === id)?.size === 384)!;
    const positionBytes = Buffer.from(observation!.buffers.find((buffer) => buffer.id === positionBufferId)!.dataBase64, "base64");
    const positions = new Float32Array(positionBytes.buffer, positionBytes.byteOffset, positionBytes.byteLength / 4);
    expect(positions[2]).toBeCloseTo(-0.1, 6);
    expect(positions[47]).toBeCloseTo(-0.1, 6);
    expect(positions[48]).toBeCloseTo(0, 6);
    expect(positions[50]).toBeCloseTo(0.1, 6);
    expect(positions[45]).toBeGreaterThan(6);
    expect(positions[46]).toBeCloseTo(0, 5);

    const uvBufferId = draw.vertexBuffers.map((buffer) => buffer.bufferId).find((id) => observation!.buffers.find((buffer) => buffer.id === id)?.size === 256)!;
    const uvBytes = Buffer.from(observation!.buffers.find((buffer) => buffer.id === uvBufferId)!.dataBase64, "base64");
    const uvs = new Float32Array(uvBytes.buffer, uvBytes.byteOffset, uvBytes.byteLength / 4);
    expect(Array.from(uvs.slice(0, 4))).toEqual([0, 0, expect.any(Number), 0]);
    expect(uvs[2]).toBeGreaterThan(0);
    expect(uvs[30]).toBeCloseTo(1, 6);
    expect(Array.from(uvs.slice(32, 34))).toEqual([0, 1]);
    expect(Array.from(uvs.slice(62, 64))).toEqual([1, 1]);

    const visiblePng = await page.screenshot();
    await page.evaluate((indexCount) => window.__playroomSuppressDirectDraw?.(indexCount, true), AIMING_INDEX_COUNT);
    await page.waitForTimeout(100);
    const suppressedPng = await page.screenshot();
    await page.evaluate((indexCount) => window.__playroomSuppressDirectDraw?.(indexCount, false), AIMING_INDEX_COUNT);
    const changedPixels = changedRibbonPixels(visiblePng, suppressedPng);
    expect(changedPixels.changed).toBeGreaterThan(500);
    expect(changedPixels.translucentRed).toBeGreaterThan(100);

    await page.locator("#playroom-free").click();
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.gamePhase === "free");
    await page.waitForTimeout(100);
    const freeCount = await page.evaluate(
        (indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length ?? 0,
        AIMING_INDEX_COUNT
    );
    await page.waitForTimeout(100);
    expect(
        await page.evaluate(
            (indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length ?? 0,
            AIMING_INDEX_COUNT
        )
    ).toBe(freeCount);

    await page.locator("#playroom-free").click();
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.gamePhase === "aiming");
    await expect
        .poll(() =>
            page.evaluate((indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length ?? 0, AIMING_INDEX_COUNT)
        )
        .toBeGreaterThan(freeCount);
    const resumedObservation = (await page.evaluate(() => window.__playroomRenderBundleObservation?.()))!;
    const resumedDraw = findLastAimingDraw(resumedObservation.directDraws);
    expect(resumedDraw.pipelineId).toBe(draw.pipelineId);
    expect(resumedDraw.vertexBuffers).toEqual(draw.vertexBuffers);

    await page.locator("#playroom-kick").click();
    await page.waitForFunction(() => document.getElementById("renderCanvas")?.dataset.gamePhase === "watching");
    await page.waitForTimeout(100);
    const flightCount = await page.evaluate(
        (indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length ?? 0,
        AIMING_INDEX_COUNT
    );
    await page.waitForTimeout(100);
    expect(
        await page.evaluate(
            (indexCount) => window.__playroomRenderBundleObservation?.().directDraws.filter((draw) => draw.indexCount === indexCount).length ?? 0,
            AIMING_INDEX_COUNT
        )
    ).toBe(flightCount);
});
