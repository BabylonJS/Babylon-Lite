import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { SceneConfig } from "../../shared/compare-core";
import { compareImages, shouldSkipParity } from "../parity/compare-utils";
import { buildParitySceneQuery, getParitySceneCaptureOptions } from "../parity/scene-capture-options";
import { renderShadoScene, startShadoSceneRunner, stopShadoSceneRunner } from "./shado-scene-runner";
import { parseShadoSceneSelection } from "./scene-selection";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const sceneConfigs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scene-config.json"), "utf8")) as SceneConfig[];
const knownSceneIds = new Set(sceneConfigs.map(({ id }) => id));

const requestedScenes = parseShadoSceneSelection(process.env.SHADO_SCENES, knownSceneIds);
const selectedSceneConfigs = requestedScenes === null ? sceneConfigs : sceneConfigs.filter(({ id }) => requestedScenes.has(id));

test.beforeAll(startShadoSceneRunner);
test.afterAll(stopShadoSceneRunner);

for (const sceneConfig of selectedSceneConfigs) {
    const goldenPath = path.join(REPO_ROOT, "reference/lite", sceneConfig.slug, "babylon-ref-golden.png");

    // Playwright requires fixture-object destructuring even though these Node-only tests use none.
    // eslint-disable-next-line no-empty-pattern
    test(`Scene ${sceneConfig.id} - ${sceneConfig.name} matches its golden in Shado`, async ({}, testInfo) => {
        test.skip(shouldSkipParity(sceneConfig), "Scene excluded from parity");
        test.skip(!fs.existsSync(goldenPath), "No committed golden is available");

        const golden = PNG.sync.read(fs.readFileSync(goldenPath));
        const captureOptions = getParitySceneCaptureOptions(sceneConfig.id);
        const { actualPath, dataset } = await renderShadoScene(sceneConfig.id, testInfo.outputPath(`scene${sceneConfig.id}-actual.png`), {
            query: buildParitySceneQuery(captureOptions),
            settleMs: captureOptions.settleMs,
            timeoutMs: captureOptions.timeoutMs,
            waitFlag: captureOptions.waitFlag ?? (captureOptions.seekTime === undefined ? undefined : "animationFrozen"),
            width: golden.width,
            height: golden.height,
        });
        if (sceneConfig.id === 115) {
            expect(Number(dataset.pickFaceId), "Shado should expose primitive-index for detailed picking").toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(Number(dataset.pickBu))).toBe(true);
            expect(Number.isFinite(Number(dataset.pickBv))).toBe(true);
            expect(dataset.pickNormal, "Shado should reconstruct the picked surface normal").not.toBe("");
        }

        // Dawn and browsers may round exact half-LSB UNORM values in opposite
        // directions. Ignore that quantization floor while preserving every
        // larger delta in the configured MAD assertion.
        const result = compareImages(actualPath, goldenPath, 1);
        expect(result.mad, `MAD should be <= ${sceneConfig.maxMad}; max channel delta was ${result.maxDiff}`).toBeLessThanOrEqual(sceneConfig.maxMad);
    });
}
