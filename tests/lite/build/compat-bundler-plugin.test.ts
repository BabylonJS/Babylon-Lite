import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";

import { liteCompat } from "../../../packages/babylon-lite-compat/src/vite";

// A build-time integration test for the `@babylonjs/lite-compat` Vite plugin:
// it must rewrite Babylon.js package imports onto `@babylonjs/lite-compat` so an
// existing Babylon.js app can build against Babylon Lite without changing a
// single import. We only cover Vite here (it ships in the repo); the other
// adapters (rollup/webpack/esbuild) share the same redirect table via
// `bundler-resolve.ts`, which the compat unit tests cover directly.

const tempDirs: string[] = [];

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Run a real Vite library build of a tiny entry whose source is `entrySource`,
 * with the compat plugin installed, and return the emitted bundle code.
 *
 * Babylon packages are kept external so we can inspect the (possibly rewritten)
 * import specifiers in the output instead of bundling the whole compat layer.
 */
async function bundleWithCompat(entrySource: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "compat-vite-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.js");
    writeFileSync(entry, entrySource);

    const result = (await build({
        configFile: false,
        logLevel: "silent",
        plugins: [liteCompat()],
        build: {
            write: false,
            minify: false,
            lib: { entry, formats: ["es"], fileName: "out" },
            rollupOptions: {
                // Externalize only the redirect *targets* (and the unsupported
                // `@babylonjs/gui` used below) — not the supported Babylon.js
                // source packages, so the plugin gets to rewrite those and we can
                // observe the (rewritten) specifiers in the emitted bundle.
                external: (id) =>
                    id === "@babylonjs/lite-compat" ||
                    /^@babylonjs\/lite-compat\//.test(id) ||
                    /^babylon-lite(\/|$)/.test(id) ||
                    /^@recast-navigation\//.test(id) ||
                    id === "@babylonjs/gui",
            },
        },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];

    const outputs = (Array.isArray(result) ? result : [result]).flatMap((o) => o.output);
    const chunk = outputs.find((o): o is Rollup.OutputChunk => o.type === "chunk");
    if (!chunk) {
        throw new Error("Vite build produced no JS chunk");
    }
    return chunk.code;
}

/** Collect every bare module specifier imported by the emitted ESM bundle. */
function importedSpecifiers(code: string): string[] {
    const specifiers = new Set<string>();
    for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?\sfrom\s+["']([^"']+)["']/g)) {
        specifiers.add(m[1]!);
    }
    return [...specifiers];
}

describe("@babylonjs/lite-compat Vite plugin", () => {
    it("rewrites @babylonjs/core (and deep subpaths) onto @babylonjs/lite-compat", async () => {
        const code = await bundleWithCompat(
            [
                'import { Vector3 } from "@babylonjs/core";',
                'import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";',
                "export const refs = [Vector3, ArcRotateCamera];",
            ].join("\n")
        );

        const specifiers = importedSpecifiers(code);
        expect(specifiers).toContain("@babylonjs/lite-compat");
        // The original Babylon.js specifiers must be gone — fully redirected.
        expect(specifiers.some((s) => s.startsWith("@babylonjs/core"))).toBe(false);
    }, 120_000);

    it("rewrites @babylonjs/loaders onto @babylonjs/lite-compat", async () => {
        const code = await bundleWithCompat(['import { registerBuiltInLoaders } from "@babylonjs/loaders";', "export const refs = [registerBuiltInLoaders];"].join("\n"));

        const specifiers = importedSpecifiers(code);
        expect(specifiers).toContain("@babylonjs/lite-compat");
        expect(specifiers.some((s) => s.startsWith("@babylonjs/loaders"))).toBe(false);
    }, 120_000);

    it("leaves unsupported Babylon.js packages untouched (fail loudly, never mis-map)", async () => {
        const code = await bundleWithCompat(['import { AdvancedDynamicTexture } from "@babylonjs/gui";', "export const refs = [AdvancedDynamicTexture];"].join("\n"));

        const specifiers = importedSpecifiers(code);
        // Out-of-scope specifiers resolve to the real Babylon.js package so a
        // missing API fails loudly instead of silently mis-mapping.
        expect(specifiers).toContain("@babylonjs/gui");
        expect(specifiers).not.toContain("@babylonjs/lite-compat");
    }, 120_000);
});
