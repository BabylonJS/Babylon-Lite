/**
 * A reusable esbuild plugin that lets an existing Babylon.js project run on
 * Babylon Lite **without changing its import statements**. It rewrites
 * `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/addons`,
 * `@babylonjs/materials`, and `@recast-navigation/*` imports
 * onto the matching `@babylonjs/lite-compat` modules at resolve time.
 *
 * Usage (`esbuild` build script):
 *
 * ```js
 * import { build } from "esbuild";
 * import { liteCompat } from "@babylonjs/lite-compat/esbuild";
 *
 * await build({
 *     plugins: [liteCompat()],
 * });
 * ```
 *
 * The redirect table is shared with every other adapter via
 * [bundler-resolve.ts](bundler-resolve.ts).
 */

import { resolveCompatSpecifier, COMPAT_SOURCE_FILTER } from "./bundler-resolve.js";

/** Minimal structural types for the slice of the esbuild plugin API used here. */
interface EsbuildResolveArgs {
    path: string;
    importer: string;
    namespace: string;
    resolveDir: string;
    kind: string;
}

interface EsbuildResolveResult {
    path: string;
    external: boolean;
    namespace: string;
    errors: unknown[];
}

interface EsbuildOnResolveResult {
    path?: string;
    external?: boolean;
    namespace?: string;
    errors?: unknown[];
}

interface EsbuildPluginBuild {
    onResolve(options: { filter: RegExp }, callback: (args: EsbuildResolveArgs) => Promise<EsbuildOnResolveResult | null>): void;
    resolve(path: string, options: { importer?: string; namespace?: string; resolveDir?: string; kind: string }): Promise<EsbuildResolveResult>;
}

interface EsbuildPlugin {
    name: string;
    setup(build: EsbuildPluginBuild): void;
}

/**
 * Create the Babylon Lite compat esbuild plugin. Add it to your build's
 * `plugins` array and keep your Babylon.js imports exactly as they are.
 */
export function liteCompat(): EsbuildPlugin {
    return {
        name: "babylonjs-lite-compat",
        setup(build) {
            build.onResolve({ filter: COMPAT_SOURCE_FILTER }, async (args) => {
                const specifier = resolveCompatSpecifier(args.path);
                if (!specifier) {
                    // Not a remapped specifier (e.g. `@babylonjs/gui`) — let esbuild
                    // resolve it normally.
                    return null;
                }
                // Re-run esbuild's own resolver on the compat specifier so the
                // package's `exports` map (source vs. dist) is honored. The result
                // does not re-match (`@babylonjs/lite-compat` maps to nothing), so
                // there is no resolution loop.
                const resolved = await build.resolve(specifier, {
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    kind: args.kind,
                });
                if (resolved.errors.length > 0) {
                    return { errors: resolved.errors };
                }
                return { path: resolved.path, external: resolved.external, namespace: resolved.namespace };
            });
        },
    };
}
