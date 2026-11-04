/**
 * A reusable Rollup plugin that lets an existing Babylon.js project run on
 * Babylon Lite **without changing its import statements**. It rewrites
 * `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/addons`,
 * `@babylonjs/materials`, and `@recast-navigation/*` imports
 * onto the matching `@babylonjs/lite-compat` modules at resolve time.
 *
 * Usage (`rollup.config.js`):
 *
 * ```js
 * import { liteCompat } from "@babylonjs/lite-compat/rollup";
 *
 * export default {
 *     plugins: [liteCompat()],
 * };
 * ```
 *
 * Rolldown shares Rollup's plugin API, so this adapter works there too. The
 * redirect table is shared with every other adapter via
 * [bundler-resolve.ts](bundler-resolve.ts).
 */

import { resolveCompatSpecifier } from "./bundler-resolve.js";

/**
 * Minimal structural type for the Rollup `PluginContext.resolve` available on
 * `this` inside `resolveId`. Typed locally so the adapter carries no `rollup`
 * dependency of its own.
 */
interface RollupResolveContext {
    resolve(source: string, importer: string | undefined, options: { skipSelf?: boolean }): Promise<{ id: string; external: boolean | string } | null>;
}

/** Minimal structural type for the Rollup plugin object this adapter returns. */
interface RollupPlugin {
    name: string;
    resolveId(this: RollupResolveContext, source: string, importer: string | undefined): Promise<string | null>;
}

/**
 * Create the Babylon Lite compat Rollup plugin. Add it to your config's
 * `plugins` array and keep your Babylon.js imports exactly as they are.
 */
export function liteCompat(): RollupPlugin {
    return {
        name: "babylonjs-lite-compat",
        async resolveId(source, importer) {
            const specifier = resolveCompatSpecifier(source);
            if (!specifier) {
                return null;
            }
            // Re-run resolution on the compat specifier so the package's `exports`
            // map (source vs. dist) is honored. `skipSelf` prevents re-entering
            // this same plugin for the redirect target.
            const resolved = await this.resolve(specifier, importer, { skipSelf: true });
            return resolved?.id ?? null;
        },
    };
}
