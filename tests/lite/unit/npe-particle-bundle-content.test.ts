import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SceneManifest {
    rawBytes?: number;
    runtimeChunks?: string[];
}

interface BundleInfo {
    chunks?: Array<{ file?: string; modules?: Array<{ id?: string }> }>;
}

const MANIFEST_DIR = resolve(__dirname, "../../../lab/public/bundle/manifest");
const BUNDLE_INFO_DIR = resolve(__dirname, "../../../lab/public/bundle/bundle-info");
const SCENE_305_SOURCE = resolve(__dirname, "../../../lab/lite/src/lite/scene305.ts");
const CANONICAL_PARTICLE_SCENES = [262, 263, 264, 276, 277, 280, 281, 283, 284];
const PROVIDER_ISOLATION_SCENES = [12, ...CANONICAL_PARTICLE_SCENES, 300, 301, 302];
const SPRITE_2D_BLEND_SCENES = [50, 300, 301];
const GRAPH_PLUMBING_SCENES = [...CANONICAL_PARTICLE_SCENES, 302, 305];
/** The per-scene manifests are build output, not tracked source, so the specs that
 *  read them self-skip in CI's Unit Tests job (which runs before any build). The
 *  Bundle Size job re-runs them after `pnpm build:bundle-scenes`, and local
 *  `pnpm test` builds first. Specs that assert on pure helpers always run. */
function scenesWithManifests(sceneIds: readonly number[]): number[] {
    return sceneIds.filter((sceneId) => existsSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`)));
}
const AVAILABLE_CANONICAL_PARTICLE_SCENES = scenesWithManifests(CANONICAL_PARTICLE_SCENES);
const AVAILABLE_PROVIDER_ISOLATION_SCENES = scenesWithManifests(PROVIDER_ISOLATION_SCENES);
const AVAILABLE_SPRITE_2D_BLEND_SCENES = scenesWithManifests(SPRITE_2D_BLEND_SCENES);
/** Optional particle features and the canonical scenes whose graphs use them. Every NPE block class loads as its own
 *  chunk, so any other canonical scene fetching one of these chunks or modules is a tree-shaking leak. */
const OPTIONAL_FEATURES: ReadonlyArray<{ pattern: RegExp; scenes: readonly number[] }> = [
    { pattern: /particle-(blend|billboard-renderable|billboard-scene)|npe-blend-modes/, scenes: [283, 284] },
    { pattern: /update-attractor-block/, scenes: [277] },
    { pattern: /update-flow-map-block/, scenes: [280] },
    { pattern: /update-noise-block/, scenes: [281] },
    { pattern: /npe-texture-content/, scenes: [280, 281] },
    {
        pattern:
            /update-(direction|angle)-block|npe-(contextual-extra|emitter-provider|graph-plumbing(?:-runtime)?|live-emitter|local-position)|random-once-typed|sprite-columns-random|particle-(condition|float-to-int|local-variable|vector-length|input-local-position)|-shape-local|(point|cone|cylinder|mesh)-shape-block|math\/mat4-invert/,
        scenes: [],
    },
];
const OPTIONAL_BLEND_MODULE = /particle\/(particle-(blend|billboard-renderable|billboard-scene)|node\/npe-blend-modes)/;
const REQUIRED_FEATURE_CHUNKS: Readonly<Record<number, readonly string[]>> = {
    277: ["update-attractor-block"],
    280: ["update-flow-map-block", "npe-texture-content"],
    281: ["update-noise-block", "npe-texture-content"],
};

function findUnusedFeatures(sceneId: number, names: readonly string[]): string[] {
    return names.filter((name) => OPTIONAL_FEATURES.some(({ pattern, scenes }) => pattern.test(name) && !scenes.includes(sceneId)));
}

describe("Particle bundle feature isolation", () => {
    it("keeps the frozen scene305 fixture free of camera controls", () => {
        expect(readFileSync(SCENE_305_SOURCE, "utf8")).not.toMatch(/\battachControl\b|arc-rotate-controls/);
    });

    it("allows an optional feature chunk only in the scenes whose graphs use it", () => {
        const chunks = ["scene277-update-attractor-block-HASH.js", "scene277-box-shape-local-HASH.js", "scene277-update-noise-block-HASH.js"];
        expect(findUnusedFeatures(277, chunks)).toEqual(chunks.slice(1));
        expect(findUnusedFeatures(262, chunks)).toEqual(chunks);
    });

    it.skipIf(AVAILABLE_CANONICAL_PARTICLE_SCENES.length === 0)("canonical particle scenes do not fetch unused optional features", () => {
        for (const sceneId of AVAILABLE_CANONICAL_PARTICLE_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const chunks = manifest.runtimeChunks ?? [];
            expect(chunks.length, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            expect(findUnusedFeatures(sceneId, chunks), `scene${sceneId} fetches unused particle feature chunks`).toEqual([]);
            for (const required of REQUIRED_FEATURE_CHUNKS[sceneId] ?? []) {
                expect(
                    chunks.some((chunk) => chunk.includes(required)),
                    `scene${sceneId} must fetch ${required}`
                ).toBe(true);
            }
            const bundleInfoPath = resolve(BUNDLE_INFO_DIR, `scene${sceneId}.json`);
            if (!existsSync(bundleInfoPath)) {
                continue;
            }

            const runtimeChunks = new Set(chunks);
            const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf8")) as BundleInfo;
            const runtimeModuleIds = (bundleInfo.chunks ?? [])
                .filter((chunk) => chunk.file && runtimeChunks.has(chunk.file))
                .flatMap((chunk) => chunk.modules ?? [])
                .map((module) => (module.id ?? "").replace(/\\/g, "/"));
            if (sceneId === 283 || sceneId === 284) {
                expect(runtimeModuleIds.filter((id) => OPTIONAL_BLEND_MODULE.test(id))).toEqual(
                    expect.arrayContaining([
                        expect.stringContaining("particle-blend"),
                        expect.stringContaining("particle-billboard-renderable"),
                        expect.stringContaining("particle-billboard-scene"),
                        expect.stringContaining("npe-blend-modes"),
                    ])
                );
            }
            const particleModules = runtimeModuleIds.filter((id) => /\/(particle|math)\//.test(id));
            expect(findUnusedFeatures(sceneId, particleModules), `scene${sceneId} folds unused optional particle features into runtime chunks`).toEqual([]);
        }
    });

    it.skipIf(AVAILABLE_PROVIDER_ISOLATION_SCENES.length === 0)("keeps the moving-emitter provider isolated to scene302", () => {
        for (const sceneId of AVAILABLE_PROVIDER_ISOLATION_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const runtimeChunks = new Set(manifest.runtimeChunks ?? []);
            expect(runtimeChunks.size, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            const providerChunks = [...runtimeChunks].filter((chunk) => /npe-(emitter-provider|live-emitter)/.test(chunk));
            if (sceneId !== 302) {
                expect(providerChunks, `scene${sceneId} must not fetch moving-emitter provider chunks`).toEqual([]);
            }

            const bundleInfoPath = resolve(BUNDLE_INFO_DIR, `scene${sceneId}.json`);
            if (!existsSync(bundleInfoPath)) {
                continue;
            }
            const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf8")) as BundleInfo;
            const providerModules = (bundleInfo.chunks ?? [])
                .filter((chunk) => chunk.file && runtimeChunks.has(chunk.file))
                .flatMap((chunk) => chunk.modules ?? [])
                .map((module) => module.id ?? "")
                .filter((id) => /\/particle\/node\/npe-(emitter-provider|live-emitter)\.[jt]s$/.test(id));
            if (sceneId === 302) {
                expect(providerModules).toEqual(expect.arrayContaining([expect.stringContaining("npe-emitter-provider")]));
                expect(providerModules.some((id) => id.includes("npe-live-emitter"))).toBe(false);
            } else {
                expect(providerModules, `scene${sceneId} must not fetch moving-emitter provider modules`).toEqual([]);
            }
        }
    });

    it.skipIf(AVAILABLE_SPRITE_2D_BLEND_SCENES.length === 0)("keeps exact Sprite2D particle blending isolated to scene301", () => {
        for (const sceneId of AVAILABLE_SPRITE_2D_BLEND_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const runtimeChunks = new Set(manifest.runtimeChunks ?? []);
            expect(runtimeChunks.size, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);

            const bundleInfoPath = resolve(BUNDLE_INFO_DIR, `scene${sceneId}.json`);
            if (!existsSync(bundleInfoPath)) {
                continue;
            }
            const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf8")) as BundleInfo;
            const runtimeModuleIds = (bundleInfo.chunks ?? [])
                .filter((chunk) => chunk.file && runtimeChunks.has(chunk.file))
                .flatMap((chunk) => chunk.modules ?? [])
                .map((module) => module.id ?? "");
            const exactModules = runtimeModuleIds.filter((id) => /\/(particle\/(particle-sprite-2d-blend-modes|particle-blend)|sprite\/sprite-custom-shader)\.[jt]s$/.test(id));

            if (sceneId === 301) {
                expect(exactModules).toEqual(
                    expect.arrayContaining([
                        expect.stringContaining("particle-sprite-2d-blend-modes"),
                        expect.stringContaining("particle-blend"),
                        expect.stringContaining("sprite-custom-shader"),
                    ])
                );
                const billboardOffenders = runtimeModuleIds.filter((id) =>
                    /\/(particle\/(particle-billboard-renderable|particle-billboard-scene|particle-scene)|sprite\/(sprite-renderable|billboard-(sprite|scene|renderable|pipeline)))\.[jt]s$/.test(
                        id
                    )
                );
                expect(billboardOffenders, "scene301 must not fetch billboard or scene-rendered sprite modules").toEqual([]);
            } else {
                expect(exactModules, `scene${sceneId} must not fetch exact Sprite2D particle blend modules`).toEqual([]);
            }
        }
    });

    for (const sceneId of GRAPH_PLUMBING_SCENES) {
        it.skipIf(scenesWithManifests([sceneId]).length === 0)(`fetches graph plumbing and local storage only for the Phase 3 graph in scene${sceneId}`, () => {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const runtimeChunks = new Set(manifest.runtimeChunks ?? []);
            expect(runtimeChunks.size, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            const normalizerChunks = [...runtimeChunks].filter((chunk) => chunk.includes("npe-graph-plumbing-runtime"));
            if (sceneId === 305) {
                expect(normalizerChunks.length, "scene305 must fetch the heavy graph-plumbing runtime chunk").toBeGreaterThan(0);
                expect(
                    [...runtimeChunks].filter((chunk) => chunk.includes("arc-rotate-controls")),
                    "scene305 must not fetch an arc-rotate-controls runtime chunk"
                ).toEqual([]);
            } else {
                expect(normalizerChunks, `scene${sceneId} must not fetch the heavy graph-plumbing runtime`).toEqual([]);
            }

            const bundleInfoPath = resolve(BUNDLE_INFO_DIR, `scene${sceneId}.json`);
            if (!existsSync(bundleInfoPath)) {
                return;
            }
            const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf8")) as BundleInfo;
            const runtimeModuleIds = (bundleInfo.chunks ?? [])
                .filter((chunk) => chunk.file && runtimeChunks.has(chunk.file))
                .flatMap((chunk) => chunk.modules ?? [])
                .map((module) => (module.id ?? "").replace(/\\/g, "/"));
            const helperModules = runtimeModuleIds.filter((id) => /\/particle\/node\/npe-graph-plumbing\.[jt]s$/.test(id));
            const runtimeModules = runtimeModuleIds.filter((id) => /\/particle\/node\/npe-graph-plumbing-runtime\.[jt]s$/.test(id));
            const localModules = runtimeModuleIds.filter((id) => /\/particle\/node\/blocks\/particle-local-variable-block\.[jt]s$/.test(id));
            if (sceneId === 305) {
                expect(
                    runtimeModuleIds.filter((id) => /\/scene305-teleport-npe\.ts$/.test(id)),
                    "scene305 must keep its checked-in graph in the ignored *-npe.ts payload convention"
                ).toHaveLength(1);
                expect(helperModules.length, "scene305 must fetch the thin graph-plumbing helper module").toBeGreaterThan(0);
                expect(runtimeModules.length, "scene305 must fetch the heavy graph-plumbing runtime module").toBeGreaterThan(0);
                expect(localModules.length, "scene305 must fetch the Particle LocalVariable evaluator").toBeGreaterThan(0);
                expect(
                    runtimeModuleIds.filter((id) => /\/camera\/arc-rotate-controls\.[jt]s$/.test(id)),
                    "scene305 must not fetch the arc-rotate-controls runtime module"
                ).toEqual([]);
                const offenders = runtimeModuleIds.filter((id) =>
                    /\/particle\/(?:particle-(?:blend|sprite-2d|sprite-2d-blend-modes)|node\/(?:npe-(?:blend-modes|emitter-provider|texture-content)|blocks\/update-(?:flow-map|noise)-block))\.[jt]s$/.test(
                        id
                    )
                );
                expect(offenders, "scene305 must contain only default-builder Phase 3 plumbing").toEqual([]);
            } else {
                expect(helperModules, `scene${sceneId} must not fetch the thin graph-plumbing helper module`).toEqual([]);
                expect(runtimeModules, `scene${sceneId} must not fetch the heavy graph-plumbing runtime module`).toEqual([]);
                expect(localModules, `scene${sceneId} must not fetch the Phase 3C local evaluator`).toEqual([]);
            }
        });
    }
});
