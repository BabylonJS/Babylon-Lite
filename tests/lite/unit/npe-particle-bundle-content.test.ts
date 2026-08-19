import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SceneManifest {
    runtimeChunks?: string[];
}

interface BundleInfo {
    chunks?: Array<{ file?: string; modules?: Array<{ id?: string }> }>;
}

const MANIFEST_DIR = resolve(__dirname, "../../../lab/public/bundle/manifest");
const BUNDLE_INFO_DIR = resolve(__dirname, "../../../lab/public/bundle/bundle-info");
const CANONICAL_PARTICLE_SCENES = [262, 263, 264, 276, 277, 280, 281, 283, 284];
const UNUSED_FEATURE_CHUNK =
    /particle-(blend|billboard-renderable|billboard-scene)|registry-(variants|extra-basic|extra-emitters|extra-remaining|extra-values|local-shapes)|update-(attractor|flow-map|noise|direction|angle)-block|npe-(blend-modes|flow-map-runtime|noise-runtime|texture-update-runtime|texture-content)|cpu-texture-source|random-once-typed|random-composed-typed|setup-sprite-sheet-random|system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|particle-input-local|local-position|box-shape-local|sphere-shape-local|point-shape|cone-shape|cylinder-shape|mesh-shape/;
const OPTIONAL_BLEND_MODULE = /particle\/(particle-(blend|billboard-renderable|billboard-scene)|node\/npe-blend-modes)/;

describe("Particle bundle feature isolation", () => {
    it("canonical particle scenes do not fetch unused optional features", () => {
        for (const sceneId of CANONICAL_PARTICLE_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const chunks = manifest.runtimeChunks ?? [];
            expect(chunks.length, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            const offenders = chunks.filter(
                (chunk) =>
                    UNUSED_FEATURE_CHUNK.test(chunk) &&
                    !(sceneId === 263 && chunk.includes("registry-extra-emitters")) &&
                    !(sceneId === 277 && (chunk.includes("registry-extra-remaining") || chunk.includes("update-attractor-block"))) &&
                    !(sceneId === 280 && (chunk.includes("npe-flow-map-runtime") || chunk.includes("npe-texture-update-runtime"))) &&
                    !(sceneId === 281 && (chunk.includes("npe-noise-runtime") || chunk.includes("npe-texture-update-runtime"))) &&
                    !((sceneId === 283 || sceneId === 284) && /particle-(blend|billboard-renderable|billboard-scene)|npe-blend-modes/.test(chunk))
            );
            expect(offenders, `scene${sceneId} fetches unused particle feature chunks`).toEqual([]);
            if (sceneId === 277) {
                expect(
                    chunks.some((chunk) => chunk.includes("update-attractor-block")),
                    "scene277 must fetch the attractor evaluator"
                ).toBe(true);
                expect(
                    chunks.some((chunk) => chunk.includes("registry-extra-remaining")),
                    "scene277 must fetch the remaining optional registry"
                ).toBe(true);
            }
            if (sceneId === 280) {
                expect(
                    chunks.some((chunk) => chunk.includes("npe-flow-map-runtime")),
                    "scene280 must fetch the specialized flow-map runtime"
                ).toBe(true);
            }
            if (sceneId === 281) {
                expect(
                    chunks.some((chunk) => chunk.includes("npe-noise-runtime")),
                    "scene281 must fetch the specialized noise-texture runtime"
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
                .map((module) => module.id ?? "");
            if (sceneId === 283 || sceneId === 284) {
                expect(runtimeModuleIds.filter((id) => OPTIONAL_BLEND_MODULE.test(id))).toEqual(
                    expect.arrayContaining([
                        expect.stringContaining("particle-blend"),
                        expect.stringContaining("particle-billboard-renderable"),
                        expect.stringContaining("particle-billboard-scene"),
                        expect.stringContaining("npe-blend-modes"),
                    ])
                );
            } else {
                expect(
                    runtimeModuleIds.filter((id) => OPTIONAL_BLEND_MODULE.test(id)),
                    `scene${sceneId} must not fetch exact or advanced particle blend modules`
                ).toEqual([]);
            }
            const moduleOffenders = runtimeModuleIds.filter(
                (id) =>
                    /particle\/(particle-billboard-renderable|node\/(npe-(flow-map-runtime|noise-runtime|texture-update-runtime|local-position|texture-content)|npe-registry-(extra-remaining|extra-values|local-shapes)|blocks\/(cpu-texture-source-block|system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|update-(attractor|flow-map|noise)-block|(box|point|sphere|cone|cylinder|mesh)-shape-local)))|math\/mat4-invert/.test(
                        id
                    ) &&
                    !(sceneId === 277 && (id.includes("npe-registry-extra-remaining") || id.includes("update-attractor-block"))) &&
                    !(
                        sceneId === 280 &&
                        (id.includes("npe-flow-map-runtime") ||
                            id.includes("npe-texture-update-runtime") ||
                            id.includes("update-flow-map-block") ||
                            id.includes("cpu-texture-source-block") ||
                            id.includes("npe-texture-content"))
                    ) &&
                    !(
                        sceneId === 281 &&
                        (id.includes("npe-noise-runtime") ||
                            id.includes("npe-texture-update-runtime") ||
                            id.includes("update-noise-block") ||
                            id.includes("cpu-texture-source-block") ||
                            id.includes("npe-texture-content"))
                    ) &&
                    !((sceneId === 283 || sceneId === 284) && OPTIONAL_BLEND_MODULE.test(id))
            );
            expect(moduleOffenders, `scene${sceneId} folds unused optional particle features into runtime chunks`).toEqual([]);
        }
    });

    it("keeps exact Sprite2D particle blending isolated to scene301", () => {
        for (const sceneId of [50, 300, 301]) {
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
});
