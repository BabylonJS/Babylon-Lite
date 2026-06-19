/**
 * Bundle-content assertion — F64 storage absent from HPM-off bundles.
 *
 * After HPM Phase 1 the F64 matrix allocator lives in its own module
 * `packages/babylon-lite/src/math/_mat4-storage-f64.ts`. Per architecture D3
 * (Tree-shaking proof), HPM-off scenes must never include any byte of that
 * module in their runtime payload. We enforce this two ways:
 *
 *   1. **String-tag absence.** The F64 module exports a unique build-time
 *      tag string `@@MAT4_STORAGE_F64@@` which is referenced inside
 *      `allocateF64Mat4` so it survives Rollup tree-shaking. Minifiers do
 *      not rename string contents, so the tag survives terser verbatim in
 *      the surviving chunk. The assertion: HPM-off scenes' entry +
 *      transitively loaded chunks contain ZERO occurrences of that tag.
 *
 *   2. **Manifest disjointness.** `lab/public/bundle/manifest.json` lists
 *      every chunk fetched at runtime for each scene. We verify that
 *      manifest.scene<N>.runtimeChunks contains zero files matching
 *      `_mat4-storage-f64`. This catches dynamic-import regressions that
 *      somehow embed the chunk reference into an HPM-off path.
 *
 * Engine.ts uses `await import("..._mat4-storage-f64.js")` inside
 * `if (useHpm)` and installs the resulting `allocateF64Mat4` into the
 * process-global matrix allocator singleton (see
 * `docs/lite/architecture/36-high-precision-matrix.md`).
 * With `useHighPrecisionMatrix` left at its default `false`, the chunk is
 * built (because some HPM-on scene reaches it, OR because Vite always
 * emits dynamic-import targets) but is never *fetched* by HPM-off scenes.
 * This test enforces both invariants.
 *
 * Requires a prior `pnpm build:bundle-scenes` run. The bundle-size test
 * suite has the same precondition.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BUILD_TAG = "@@MAT4_STORAGE_F64@@";
const F64_MODULE_HINT = /_mat4-storage-f64/;
const BUNDLE_DIR = resolve(__dirname, "..", "..", "..", "lab", "public", "bundle");
const MANIFEST_PATH = join(BUNDLE_DIR, "manifest.json");
const SCENE_CONFIG_PATH = resolve(__dirname, "..", "..", "..", "scene-config.json");

interface BundleManifestEntry {
    rawKB?: number;
    runtimeChunks?: string[];
}
type BundleManifest = Record<string, BundleManifestEntry>;

/** HPM-off scene used as the canonical target. scene2 is the smallest /
 *  simplest non-HPM scene in the gallery (sphere + directional light). */
const HPM_OFF_SCENE = "scene2";

/** When true, the bundle directory has been freshly built and the
 *  per-scene chunk `.js` files (including the F64 chunk for HPM-on
 *  scenes) are present. When false, only the committed `manifest.json`
 *  exists — typically when this file is run via `pnpm exec vitest run`
 *  in CI's Unit Tests job before any build step. In that case we skip
 *  the chunk-content assertions; the Bundle Size CI job re-runs them
 *  after `pnpm build:bundle-scenes`. Local `pnpm test` always runs
 *  build:bundle-scenes first, so the assertions run in full there. */
const HAS_BUILT_CHUNKS = existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).some((f) => F64_MODULE_HINT.test(f) && f.endsWith(".js"));

describe("bundle content: F64 storage tag absent from HPM-off bundles", () => {
    it("manifest exists (run `pnpm build:bundle-scenes` first)", () => {
        expect(existsSync(MANIFEST_PATH), `Missing bundle manifest at ${MANIFEST_PATH}. Run \`pnpm build:bundle-scenes\` first.`).toBe(true);
    });

    it.skipIf(!HAS_BUILT_CHUNKS)(`F64 chunk file is emitted somewhere in lab/public/bundle/ (positive control)`, () => {
        const f64Chunks = readdirSync(BUNDLE_DIR).filter((f) => F64_MODULE_HINT.test(f) && f.endsWith(".js"));
        expect(f64Chunks.length, "Expected at least one `*_mat4-storage-f64*.js` chunk to be emitted by the build").toBeGreaterThan(0);
        // The build tag MUST appear verbatim in that chunk — otherwise the
        // sentinel was DCE'd and the absence assertions below are vacuous.
        for (const chunk of f64Chunks) {
            const text = readFileSync(join(BUNDLE_DIR, chunk), "utf-8");
            expect(text, `Build tag missing from ${chunk}; check _mat4-storage-f64.ts embedding`).toContain(BUILD_TAG);
        }
    });

    it(`${HPM_OFF_SCENE}: runtime chunks do NOT reference the F64 storage module`, () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as BundleManifest;
        const entry = manifest[HPM_OFF_SCENE];
        expect(entry, `${HPM_OFF_SCENE} missing from manifest.json`).toBeDefined();
        const chunks = entry!.runtimeChunks ?? [];
        expect(chunks.length, `${HPM_OFF_SCENE} has no runtimeChunks recorded`).toBeGreaterThan(0);
        const offenders = chunks.filter((c) => F64_MODULE_HINT.test(c));
        expect(offenders, `HPM-off scene ${HPM_OFF_SCENE} loads F64 chunk(s) at runtime: ${offenders.join(", ")}`).toEqual([]);
    });

    it.skipIf(!HAS_BUILT_CHUNKS)(`${HPM_OFF_SCENE}: no runtime chunk contains the F64 build tag`, () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as BundleManifest;
        const chunks = manifest[HPM_OFF_SCENE]?.runtimeChunks ?? [];
        const offenders: string[] = [];
        for (const chunk of chunks) {
            const abs = join(BUNDLE_DIR, chunk);
            if (!existsSync(abs)) {
                continue;
            }
            const text = readFileSync(abs, "utf-8");
            if (text.includes(BUILD_TAG)) {
                offenders.push(chunk);
            }
        }
        expect(offenders, `HPM-off scene ${HPM_OFF_SCENE} chunks contain F64 build tag: ${offenders.join(", ")}`).toEqual([]);
    });

    it("every other HPM-off scene also lacks the F64 chunk in its runtimeChunks", () => {
        // Defensive sweep across the whole manifest. HPM-on scenes legitimately
        // load the F64 chunk (they create the engine with
        // `useHighPrecisionMatrix: true` — e.g. the high-precision-jitter and
        // floating-origin/LWR scenes). Derive that whitelist from
        // scene-config.json (scenes tagged "hpm", minus the explicit hpm-off
        // control) so it never goes stale as new HPM/floating-origin scenes are
        // added — a hardcoded slug list silently rots when the manifest is
        // regenerated after new HPM scenes land.
        const sceneConfig = JSON.parse(readFileSync(SCENE_CONFIG_PATH, "utf-8")) as Array<{ id?: number; slug?: string; tags?: string[] }>;
        const HPM_ON_SLUGS = new Set<string>(
            sceneConfig.filter((s) => (s.tags ?? []).includes("hpm") && !(s.slug ?? "").includes("hpm-off") && s.id != null).map((s) => `scene${s.id}`)
        );
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as BundleManifest;
        const failures: string[] = [];
        for (const [sceneKey, entry] of Object.entries(manifest)) {
            if (HPM_ON_SLUGS.has(sceneKey)) {
                continue;
            }
            if (sceneKey.startsWith("bjs-")) {
                continue;
            }
            const chunks = entry.runtimeChunks ?? [];
            const offenders = chunks.filter((c) => F64_MODULE_HINT.test(c));
            if (offenders.length > 0) {
                failures.push(`${sceneKey}: ${offenders.join(", ")}`);
            }
        }
        expect(failures, `HPM-off scenes unexpectedly load F64 chunk:\n${failures.join("\n")}`).toEqual([]);
    });
});
