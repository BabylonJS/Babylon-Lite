/**
 * A reusable Webpack plugin that lets an existing Babylon.js project run on
 * Babylon Lite **without changing its import statements**. It rewrites
 * `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/addons`,
 * `@babylonjs/materials`, and `@recast-navigation/*` imports
 * onto the matching `@babylonjs/lite-compat` modules before Webpack resolves
 * them, by rewriting the request and letting Webpack's own resolver (and the
 * package's `exports` map) take it from there.
 *
 * Usage (`webpack.config.js`):
 *
 * ```js
 * const { LiteCompatPlugin } = require("@babylonjs/lite-compat/webpack");
 *
 * module.exports = {
 *     plugins: [new LiteCompatPlugin()],
 * };
 * ```
 *
 * Built on Webpack 5's `NormalModuleReplacementPlugin` (reached via
 * `compiler.webpack`), so the adapter needs no `webpack` dependency of its own.
 * Rspack implements the same plugin interface, so this adapter works there too.
 * The redirect table is shared with every other adapter via
 * [bundler-resolve.ts](bundler-resolve.ts).
 */

import { resolveCompatSpecifier, COMPAT_SOURCE_FILTER } from "./bundler-resolve.js";

/** Minimal structural type for the request object Webpack hands the replacer. */
interface WebpackResource {
    request: string;
}

/** Minimal structural type for `compiler.webpack.NormalModuleReplacementPlugin`. */
interface NormalModuleReplacementPluginCtor {
    new (
        resourceRegExp: RegExp,
        newResource: (resource: WebpackResource) => void
    ): {
        apply(compiler: WebpackCompiler): void;
    };
}

/** Minimal structural type for the Webpack 5 compiler this plugin needs. */
interface WebpackCompiler {
    webpack: { NormalModuleReplacementPlugin: NormalModuleReplacementPluginCtor };
}

/**
 * Webpack (and Rspack) plugin that redirects Babylon.js imports onto the
 * `@babylonjs/lite-compat` layer. Add `new LiteCompatPlugin()` to your config's
 * `plugins` array and keep your Babylon.js imports exactly as they are.
 */
export class LiteCompatPlugin {
    apply(compiler: WebpackCompiler): void {
        const { NormalModuleReplacementPlugin } = compiler.webpack;
        new NormalModuleReplacementPlugin(COMPAT_SOURCE_FILTER, (resource) => {
            const specifier = resolveCompatSpecifier(resource.request);
            if (specifier) {
                resource.request = specifier;
            }
        }).apply(compiler);
    }
}
