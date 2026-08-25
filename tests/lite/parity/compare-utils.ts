/**
 * Parity compare-utils for the WebGPU lab. The comparison math + golden-capture
 * engine live in tests/shared/compare-core.ts (shared with the GL lab); this file
 * supplies only the WebGPU specifics: scene-config.json, the
 * /babylon-ref-scene{id}.html reference pages, reference/lite/<slug>/, and the
 * BJS loading-screen wait the WebGPU lab needs before screenshotting.
 */
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "@playwright/test";
import { captureGolden as captureGoldenCore, shouldSkipParity, type SceneConfig, type CaptureGoldenOptions } from "../../shared/compare-core";

// Re-export the experience-agnostic comparison surface unchanged.
export { compareImages, compareRegion, generateDiffMap, attachCompareArtifacts, shouldSkipParity, waitForCanvasReady } from "../../shared/compare-core";
export type { SceneConfig, CompareResult, RegionResult, CaptureGoldenOptions } from "../../shared/compare-core";

let _sceneConfigCache: SceneConfig[] | null = null;

function loadSceneConfigAll(): SceneConfig[] {
    if (!_sceneConfigCache) {
        const configPath = path.resolve(__dirname, "../../../scene-config.json");
        _sceneConfigCache = JSON.parse(fs.readFileSync(configPath, "utf-8")) as SceneConfig[];
    }
    return _sceneConfigCache;
}

/** Load the MAD threshold config for a scene by its ID. */
export function getSceneConfig(sceneId: number): SceneConfig {
    const all = loadSceneConfigAll();
    const entry = all.find((s) => s.id === sceneId);
    if (!entry) {
        throw new Error(`No scene-config.json entry for scene ${sceneId}`);
    }
    return {
        ...entry,
        skipParity: shouldSkipParity(entry) || undefined,
    };
}

/** Capture (or reuse) the Babylon golden reference for a scene. */
export function captureGolden(browser: Browser, opts: CaptureGoldenOptions): Promise<string> {
    return captureGoldenCore(browser, opts, {
        refBaseDir: path.resolve(__dirname, "../../../reference/lite"),
        slugForScene: (id) => getSceneConfig(id).slug,
        refUrl: (id, query) => `/babylon-ref-scene${id}.html${query}`,
        waitForBabylonLoadingScreen: true,
    });
}
