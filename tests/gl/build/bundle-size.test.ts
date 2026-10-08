import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { resolve } from "path";
import { loadSceneConfig, liteGlAlias, measureSceneBundle, repoRoot } from "../../../scripts/bundle-scenes-gl-core";

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

    it("keeps 3D bindings out of byte-stable 2D-only texture bundles", async () => {
        const bundle = async (name: string) =>
            (
                await build({
                    stdin: { contents: `export { ${name} } from "babylon-lite-gl";`, resolveDir: repoRoot, sourcefile: "texture-entry.ts" },
                    bundle: true,
                    minify: true,
                    treeShaking: true,
                    format: "esm",
                    target: "esnext",
                    platform: "browser",
                    legalComments: "none",
                    alias: liteGlAlias,
                    write: false,
                })
            ).outputFiles[0]!;

        // Exact pre-3D sizes, measured with this same esbuild configuration at HEAD.
        for (const [name, maxBytes] of [
            ["createRawTexture", 1672],
            ["bindTexture", 317],
            ["setEffectTexture", 419],
        ] as const) {
            const output = await bundle(name);
            expect(output.contents.byteLength, `${name} grew beyond its pre-3D bundle`).toBeLessThanOrEqual(maxBytes);
            expect(output.text).not.toMatch(/texImage3D|TEXTURE_3D|_boundTextures3D/);
        }
        expect((await bundle("createTexture3DFromPixels")).text).toContain("texImage3D");
    });

    for (const [sceneId, baselineBytes] of [
        [1, 11801],
        [3, 16762],
        [6, 14850],
    ] as const) {
        it(`keeps 2D-only scene${sceneId} at or below its pre-3D byte count`, async () => {
            const result = await build({
                entryPoints: [resolve(repoRoot, `lab/gl/src/scene${sceneId}.ts`)],
                bundle: true,
                minify: true,
                treeShaking: true,
                format: "esm",
                target: "esnext",
                platform: "browser",
                legalComments: "none",
                alias: liteGlAlias,
                write: false,
            });
            expect(result.outputFiles[0]!.contents.byteLength).toBeLessThanOrEqual(baselineBytes);
        });
    }

    it("shared stencil consumers do not retain two-sided stencil code", async () => {
        const result = await build({
            stdin: {
                contents: 'export { setStencilState } from "babylon-lite-gl";',
                resolveDir: repoRoot,
                sourcefile: "shared-stencil.ts",
            },
            bundle: true,
            minify: true,
            treeShaking: true,
            format: "esm",
            target: "esnext",
            platform: "browser",
            legalComments: "none",
            alias: liteGlAlias,
            write: false,
        });
        const output = result.outputFiles[0]!.text;
        expect(output).toContain("stencilOp(");
        expect(output).not.toContain("stencilOpSeparate");
        expect(output).not.toContain("invalid face");
        expect(output).not.toContain("Float64Array(52)");
    });

    it("keeps opt-in readiness scheduling out of manual effect bundles", async () => {
        const bundle = async (exports: string) =>
            (
                await build({
                    stdin: { contents: `export { ${exports} } from "babylon-lite-gl";`, resolveDir: repoRoot, sourcefile: "effect-entry.ts" },
                    bundle: true,
                    minify: true,
                    treeShaking: true,
                    format: "esm",
                    target: "esnext",
                    platform: "browser",
                    legalComments: "none",
                    alias: liteGlAlias,
                    write: false,
                })
            ).outputFiles[0]!.text;
        const manual = await bundle("createEffect, isEffectReady, getEffectCompilationError, executeWhenCompiled");
        expect(manual).not.toMatch(/requestAnimationFrame|cancelAnimationFrame|new Promise|addEventListener/);
        const waiting = await bundle("waitForEffect");
        expect(waiting).toContain("requestAnimationFrame");
        expect(waiting).toContain("cancelAnimationFrame");
        expect(waiting).toContain("new Promise");
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
