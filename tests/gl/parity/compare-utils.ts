/**
 * Parity compare-utils for the GL lab. The comparison math + golden-capture
 * engine live in tests/shared/compare-core.ts (shared with the WebGPU lab); this
 * file supplies only the GL specifics: scene-config-webgl.json, the
 * /gl/babylon-ref-scene{id}.html reference pages, and reference/gl/<slug>/.
 */
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "@playwright/test";
import { captureGolden as captureGoldenCore, shouldSkipParity, type SceneConfig, type CaptureGoldenOptions } from "../../shared/compare-core";

// Re-export the experience-agnostic comparison surface unchanged.
export { compareImages, compareRegion, generateDiffMap, attachCompareArtifacts, shouldSkipParity, waitForCanvasReady } from "../../shared/compare-core";
export type { SceneConfig, CompareResult, RegionResult, CaptureGoldenOptions } from "../../shared/compare-core";

let _sceneConfigCache: SceneConfig[] | null = null;

/** Load every entry from scene-config-webgl.json (cached). */
export function loadSceneConfigAll(): SceneConfig[] {
    if (!_sceneConfigCache) {
        const configPath = path.resolve(__dirname, "../../../scene-config-webgl.json");
        _sceneConfigCache = JSON.parse(fs.readFileSync(configPath, "utf-8")) as SceneConfig[];
    }
    return _sceneConfigCache;
}

/** Load the MAD threshold config for a GL scene by its ID. */
export function getSceneConfig(sceneId: number): SceneConfig {
    const all = loadSceneConfigAll();
    const entry = all.find((s) => s.id === sceneId);
    if (!entry) {
        throw new Error(`No scene-config-webgl.json entry for scene ${sceneId}`);
    }
    return {
        ...entry,
        skipParity: shouldSkipParity(entry) || undefined,
    };
}

/** Capture (or reuse) the Babylon ThinEngine golden for a GL scene. */
export function captureGolden(browser: Browser, opts: CaptureGoldenOptions): Promise<string> {
    return captureGoldenCore(browser, opts, {
        refBaseDir: path.resolve(__dirname, "../../../reference/gl"),
        slugForScene: (id) => getSceneConfig(id).slug,
        refUrl: (id, query) => `/gl/babylon-ref-scene${id}.html${query}`,
        waitForBabylonLoadingScreen: false,
    });
}
