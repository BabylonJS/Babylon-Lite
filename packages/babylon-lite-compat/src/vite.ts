/**
 * A reusable Vite plugin that lets an existing Babylon.js project run on Babylon
 * Lite **without changing its import statements**. It rewrites `@babylonjs/core`,
 * `@babylonjs/loaders`, `@babylonjs/addons`, `@babylonjs/materials`, and
 * `@recast-navigation/*` imports
 * onto the matching `@babylonjs/lite-compat` modules at resolve time, so the
 * compat layer (which runs on Babylon Lite's WebGPU renderer) is loaded in place
 * of Babylon.js.
 *
 * Usage (`vite.config.ts`):
 *
 * ```ts
 * import { defineConfig } from "vite";
 * import { liteCompat } from "@babylonjs/lite-compat/vite";
 *
 * export default defineConfig({
 *     plugins: [liteCompat()],
 * });
 * ```
 *
 * The redirect table is shared with the other bundler adapters and the lab
 * harness via [bundler-resolve.ts](bundler-resolve.ts) so they can never diverge.
 */

import type { Plugin } from "vite";
import { resolveCompatSpecifier } from "./bundler-resolve.js";

/**
 * Create the Babylon Lite compat Vite plugin. Add it to your config's `plugins`
 * array and keep your Babylon.js imports exactly as they are — they resolve to
 * the compat layer instead of Babylon.js.
 */
export function liteCompat(): Plugin {
    return {
        name: "babylonjs-lite-compat",
        // `pre` so the redirect happens before Vite's own resolver/optimizer sees
        // the original Babylon.js specifier.
        enforce: "pre",
        async resolveId(source, importer, options) {
            const specifier = resolveCompatSpecifier(source);
            if (!specifier) {
                return null;
            }
            // Re-run resolution on the compat specifier so the package's `exports`
            // map (source vs. dist) is honored. `skipSelf` prevents re-entering
            // this same plugin for the redirect target.
            const resolved = await this.resolve(specifier, importer, {
                ...options,
                skipSelf: true,
            });
            return resolved?.id ?? null;
        },
    };
}
