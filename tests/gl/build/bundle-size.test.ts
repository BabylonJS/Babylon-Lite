import { describe, expect, it } from "vitest";
import { loadSceneConfig, measureSceneBundle } from "../../../scripts/bundle-scenes-gl-core";

/**
 * GL bundle-size ceilings — the WebGL analogue of the WebGPU
 * tests/lite/parity/bundle-size.spec.ts. Each GL scene's standalone, tree-shaken,
 * minified @babylonjs/lite-gl bundle must stay within its `maxRawKB` ceiling in
 * scene-config-webgl.json, so accidental growth (e.g. a new import dragging extra
 * code into a scene) fails the build instead of silently shipping.
 *
 * Reuses the exact esbuild measurement the dashboard "Bundle" tab reports
 * (scripts/bundle-scenes-gl-core.ts). Runs in the `gl-build` vitest project,
 * which CI already executes — no separate browser/build step required.
 */
describe("babylon-lite-gl bundle size ceilings", () => {
    const allScenes = loadSceneConfig();
    const scenes = allScenes.filter((s) => s.maxRawKB != null);

    it("every GL scene declares a maxRawKB ceiling", () => {
        const missing = allScenes.filter((s) => s.maxRawKB == null).map((s) => s.slug);
        expect(missing, `scenes missing a maxRawKB ceiling in scene-config-webgl.json: ${missing.join(", ")}`).toEqual([]);
    });

    for (const scene of scenes) {
        it(`scene${scene.id} (${scene.slug}) ≤ ${scene.maxRawKB} KB raw`, async () => {
            const { rawKB, gzipKB } = await measureSceneBundle(scene.id);
            console.log(`  scene${scene.id} (${scene.slug}): ${rawKB} KB raw (ceiling ${scene.maxRawKB} KB) / ${gzipKB} KB gzip`);
            expect(
                rawKB,
                `scene${scene.id} (${scene.slug}) bundle ${rawKB} KB exceeds ceiling ${scene.maxRawKB} KB ` +
                    `(+${(rawKB - scene.maxRawKB!).toFixed(1)} KB over) — trim imports, or if the growth is intentional raise maxRawKB in scene-config-webgl.json`
            ).toBeLessThanOrEqual(scene.maxRawKB!);
        }, 60_000);
    }
});
