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
const CANONICAL_PARTICLE_SCENES = [262, 263, 264, 276, 277];
/** The per-scene manifests are build output, not tracked source, so this spec
 *  self-skips in CI's Unit Tests job (which runs before any build). The Bundle
 *  Size job re-runs it after `pnpm build:bundle-scenes`, and local `pnpm test`
 *  builds first. */
const HAS_MANIFEST = CANONICAL_PARTICLE_SCENES.every((sceneId) => existsSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`)));
const UNUSED_FEATURE_CHUNK =
    /registry-(variants|extra-basic|extra-emitters|extra-remaining|extra-values|local-shapes)|update-(attractor|direction|angle)-block|random-once-typed|random-composed-typed|setup-sprite-sheet-random|system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|particle-input-local|local-position|box-shape-local|sphere-shape-local|point-shape|cone-shape|cylinder-shape|mesh-shape/;

describe("Particle bundle feature isolation", () => {
    it.skipIf(!HAS_MANIFEST)("canonical particle scenes do not fetch unused optional features", () => {
        for (const sceneId of CANONICAL_PARTICLE_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const chunks = manifest.runtimeChunks ?? [];
            expect(chunks.length, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            const offenders = chunks.filter(
                (chunk) =>
                    UNUSED_FEATURE_CHUNK.test(chunk) &&
                    !(sceneId === 263 && chunk.includes("registry-extra-emitters")) &&
                    !(sceneId === 277 && (chunk.includes("registry-extra-remaining") || chunk.includes("update-attractor-block")))
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

            const bundleInfoPath = resolve(BUNDLE_INFO_DIR, `scene${sceneId}.json`);
            if (!existsSync(bundleInfoPath)) {
                continue;
            }

            const runtimeChunks = new Set(chunks);
            const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf8")) as BundleInfo;
            const moduleOffenders = (bundleInfo.chunks ?? [])
                .filter((chunk) => chunk.file && runtimeChunks.has(chunk.file))
                .flatMap((chunk) => chunk.modules ?? [])
                .map((module) => module.id ?? "")
                .filter(
                    (id) =>
                        /particle\/node\/(npe-registry-(extra-remaining|extra-values|local-shapes)|npe-local-position|blocks\/(system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|update-attractor-block|(box|point|sphere|cone|cylinder|mesh)-shape-local))|math\/mat4-invert/.test(
                            id
                        ) && !(sceneId === 277 && (id.includes("npe-registry-extra-remaining") || id.includes("update-attractor-block")))
                );
            expect(moduleOffenders, `scene${sceneId} folds unused optional particle features into runtime chunks`).toEqual([]);
        }
    });
});
