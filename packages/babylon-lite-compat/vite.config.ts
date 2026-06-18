import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { writeFileSync } from "fs";
import dts from "vite-plugin-dts";

/**
 * The package's public entry points. Each becomes a standalone ESM file in
 * `dist/` and a matching subpath in the emitted publish `package.json`. The keys
 * are the output basenames; the values are the source modules.
 *
 * `vite` is a build-time-only entry (the consumer plugin) — it imports nothing
 * from Babylon Lite at runtime, so it bundles to a tiny standalone file.
 */
const ENTRIES = {
    index: "src/index.ts",
    vite: "src/vite.ts",
    rollup: "src/rollup.ts",
    webpack: "src/webpack.ts",
    esbuild: "src/esbuild.ts",
    navigation: "src/navigation/navigation.ts",
    "recast-shim": "src/navigation/recast-shim.ts",
} as const;

/**
 * `types` entry-point for each export subpath. vite-plugin-dts mirrors the `src`
 * tree into `dist/`, so the declaration paths follow the original filenames
 * (e.g. `navigation/navigation.ts` → `navigation/navigation.d.ts`) rather than
 * the bundled basenames.
 */
const TYPES_PATH: Record<keyof typeof ENTRIES, string> = {
    index: "./index.d.ts",
    vite: "./vite.d.ts",
    rollup: "./rollup.d.ts",
    webpack: "./webpack.d.ts",
    esbuild: "./esbuild.d.ts",
    navigation: "./navigation/navigation.d.ts",
    "recast-shim": "./navigation/recast-shim.d.ts",
};

/** Map an entry key to its public export subpath (`index` → `.`). */
function exportKey(name: keyof typeof ENTRIES): string {
    return name === "index" ? "." : `./${name}`;
}

/** Emit a publish-ready `package.json` into the build output directory. */
function emitPackageJson(outDir: string): Plugin {
    return {
        name: "emit-package-json",
        writeBundle() {
            const exports: Record<string, { import: string; types: string }> = {};
            for (const name of Object.keys(ENTRIES) as (keyof typeof ENTRIES)[]) {
                exports[exportKey(name)] = {
                    import: `./${name}.js`,
                    types: TYPES_PATH[name],
                };
            }
            const pkg = {
                name: "@babylonjs/lite-compat",
                version: "0.0.1",
                license: "Apache-2.0",
                type: "module",
                description:
                    "Opt-in Babylon.js-shaped compatibility layer implemented on top of the Babylon Lite public API. Provides a migration runway from Babylon.js to Babylon Lite.",
                main: "./index.js",
                module: "./index.js",
                types: "./index.d.ts",
                exports,
                sideEffects: false,
                peerDependencies: {
                    "@babylonjs/lite": "*",
                },
                peerDependenciesMeta: {
                    vite: { optional: true },
                },
            };
            writeFileSync(resolve(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
        },
    };
}

export default defineConfig(({ mode }) => {
    const outDir = "dist";
    const isWatch = process.argv.includes("--watch");
    return {
        build: {
            lib: {
                entry: Object.fromEntries(Object.entries(ENTRIES).map(([name, src]) => [name, resolve(__dirname, src)])),
                formats: ["es"],
            },
            outDir,
            sourcemap: true,
            minify: mode === "prod" ? "esbuild" : false,
            rollupOptions: {
                // Babylon Lite (and the Recast packages it uses) are runtime peers — keep
                // them external so the compat layer rides on the consumer's single Babylon
                // Lite instance instead of inlining a second copy. `vite` is only a
                // build-time type for the plugin entry.
                external: (id) => /^babylon-lite(\/|$)/.test(id) || /^@recast-navigation\/(core|generators|wasm)(\/|$)/.test(id) || id === "vite",
                output: {
                    // In this monorepo the workspace package is named `babylon-lite`, but it
                    // publishes to npm as `@babylonjs/lite`. Rewrite the external import
                    // specifiers in the emitted bundle so the published compat package points
                    // at the published Babylon Lite package. Other externals pass through.
                    paths: (id) => (id === "babylon-lite" || id.startsWith("babylon-lite/") ? id.replace(/^babylon-lite/, "@babylonjs/lite") : id),
                },
            },
        },
        plugins: [
            dts({
                rollupTypes: false,
                tsconfigPath: resolve(__dirname, "tsconfig.json"),
                outDir,
            }),
            ...(isWatch ? [] : [emitPackageJson(outDir)]),
        ],
    };
});
