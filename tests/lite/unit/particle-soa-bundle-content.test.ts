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
const EXISTING_PARTICLE_SCENES = [262, 263, 264, 268];
const UNUSED_FEATURE_CHUNK =
    /registry-(variants|extra-basic|extra-emitters|extra-values|local-shapes)|update-(direction|angle)-block|random-once-typed|random-composed-typed|setup-sprite-sheet-random|system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|particle-input-local|local-position|box-shape-local|sphere-shape-local|point-shape|cone-shape|cylinder-shape|mesh-shape/;

describe("SoA particle bundle feature isolation", () => {
    it("existing particle scenes do not fetch unused Basic, emitter, or local-space features", () => {
        for (const sceneId of EXISTING_PARTICLE_SCENES) {
            const manifest = JSON.parse(readFileSync(resolve(MANIFEST_DIR, `scene${sceneId}.json`), "utf8")) as SceneManifest;
            const chunks = manifest.runtimeChunks ?? [];
            expect(chunks.length, `scene${sceneId} has no runtime chunks recorded`).toBeGreaterThan(0);
            const offenders = chunks.filter((chunk) => UNUSED_FEATURE_CHUNK.test(chunk) && !(sceneId === 263 && chunk.includes("registry-extra-emitters")));
            expect(offenders, `scene${sceneId} fetches unused particle feature chunks`).toEqual([]);

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
                .filter((id) =>
                    /particle\/soa\/(registry-(extra-values|local-shapes)|local-position|blocks\/(system-dynamic-emit-rate|particle-(condition|float-to-int|vector-length)|(box|point|sphere|cone|cylinder|mesh)-shape-local))|math\/mat4-invert/.test(
                        id
                    )
                );
            expect(moduleOffenders, `scene${sceneId} folds unused dynamic-rate, value, local, or inverse-matrix code into fetched chunks`).toEqual([]);
        }
    });
});
