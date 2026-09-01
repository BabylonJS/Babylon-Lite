import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { SceneConfig } from "../../shared/compare-core";
import { compareImages, shouldSkipParity } from "../parity/compare-utils";
import { renderShadoScene, startShadoSceneRunner, stopShadoSceneRunner, type ShadoSceneOptions } from "./shado-scene-runner";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const sceneConfigs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scene-config.json"), "utf8")) as SceneConfig[];
const requestedScenes = new Set(
    (process.env.SHADO_SCENES ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite)
);

const sceneOptions = new Map<number, ShadoSceneOptions>([
    [58, { query: "?seekTime=0.72", waitFlag: "animationFrozen", settleMs: 500 }],
    [59, { query: "?seekTime=0.72", waitFlag: "animationFrozen", settleMs: 500 }],
    [81, { settleMs: 500 }],
    [100, { query: "?captureFrame=120", waitFlag: "captureReady" }],
    [101, { query: "?captureFrame=150", waitFlag: "captureReady" }],
    [102, { query: "?captureFrame=5", waitFlag: "captureReady" }],
    [103, { query: "?captureFrame=5", waitFlag: "captureReady" }],
    [104, { query: "?captureFrame=35", waitFlag: "captureReady" }],
    [105, { query: "?captureFrame=55", waitFlag: "captureReady" }],
    [106, { query: "?captureFrame=20", waitFlag: "captureReady" }],
    [112, { settleMs: 2_000, timeoutMs: 180_000 }],
    [113, { settleMs: 1_000, timeoutMs: 90_000 }],
    [115, { query: `?seekTime=${100 / 60}`, waitFlag: "animationFrozen", settleMs: 1_000, timeoutMs: 120_000 }],
    [116, { settleMs: 1_000 }],
    [117, { settleMs: 1_000, timeoutMs: 90_000 }],
    [118, { settleMs: 1_000, timeoutMs: 90_000 }],
    [143, { settleMs: 500, timeoutMs: 120_000 }],
    [160, { settleMs: 500 }],
    [166, { settleMs: 1_000, timeoutMs: 180_000 }],
    [167, { settleMs: 1_000, timeoutMs: 180_000 }],
    [179, { settleMs: 1_000, timeoutMs: 180_000 }],
    [205, { settleMs: 500 }],
    [206, { settleMs: 500 }],
    [209, { settleMs: 500 }],
    [226, { settleMs: 800, timeoutMs: 150_000 }],
    [231, { query: "?seekTime=0.5", waitFlag: "animationFrozen", settleMs: 500 }],
    [250, { query: "?seekTime=5", waitFlag: "animationFrozen", timeoutMs: 90_000 }],
    [278, { settleMs: 300 }],
    [280, { settleMs: 500 }],
    [281, { settleMs: 500 }],
    [302, { query: "?seekTime=2", waitFlag: "animationFrozen" }],
]);

test.beforeAll(startShadoSceneRunner);
test.afterAll(stopShadoSceneRunner);

for (const sceneConfig of sceneConfigs) {
    const goldenPath = path.join(REPO_ROOT, "reference/lite", sceneConfig.slug, "babylon-ref-golden.png");
    const selected = requestedScenes.size === 0 || requestedScenes.has(sceneConfig.id);

    // Playwright requires fixture-object destructuring even though these Node-only tests use none.
    // eslint-disable-next-line no-empty-pattern
    test(`Scene ${sceneConfig.id} - ${sceneConfig.name} matches its golden in Shado`, async ({}, testInfo) => {
        test.skip(!selected, "Scene excluded by SHADO_SCENES");
        test.skip(shouldSkipParity(sceneConfig), "Scene excluded from parity");
        test.skip(!fs.existsSync(goldenPath), "No committed golden is available");

        const golden = PNG.sync.read(fs.readFileSync(goldenPath));
        const { actualPath } = await renderShadoScene(sceneConfig.id, testInfo.outputPath(`scene${sceneConfig.id}-actual.png`), {
            ...sceneOptions.get(sceneConfig.id),
            width: golden.width,
            height: golden.height,
        });
        const result = compareImages(actualPath, goldenPath);
        expect(result.mad, `MAD should be <= ${sceneConfig.maxMad}; max channel delta was ${result.maxDiff}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    });
}
