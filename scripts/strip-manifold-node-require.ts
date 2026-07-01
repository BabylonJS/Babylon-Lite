/**
 * Strip `manifold-3d`'s Node-only `await import("module")` from browser builds.
 *
 * `manifold-3d`'s Emscripten glue does:
 *
 *     if (ENVIRONMENT_IS_NODE) {
 *       const { createRequire } = await import("module");
 *       var require = createRequire(import.meta.url);
 *     }
 *
 * `ENVIRONMENT_IS_NODE` is false in a browser, so that branch is dead — but Rollup/esbuild
 * resolve the `import("module")` specifier EAGERLY, before dead-code elimination. Left alone,
 * Vite answers it with a `__vite-browser-external` stub chunk which, in the module-granular
 * `lib` build, also absorbs an unrelated first-party public export (`computeAabb` was observed
 * being re-exported out of that stub chunk). Pointing `module` at a shim avoids the stub but
 * still ships a small `createRequire` chunk.
 *
 * This plugin instead rewrites the dynamic import itself to an inline, already-resolved stub, so
 * there is no `module` specifier to resolve and nothing extra is emitted: the prebundled `dist`
 * build then dead-code-eliminates the whole Node branch, and the `lib` build keeps `computeAabb`
 * in its own module. The replacement lives in the never-executed Node branch and throws only if
 * somehow reached in a browser build.
 *
 * Robustness: if a future `manifold-3d` is present but no longer matches the expected import
 * pattern, the plugin fails the build (rather than silently letting the stub chunk return) so the
 * browser Node-builtin handling gets re-verified.
 */
import { type Plugin } from "vite";

const MANIFOLD_ENTRY = /[\\/]manifold-3d[\\/]manifold\.js$/;
const NODE_MODULE_IMPORT = /import\(\s*['"](?:node:)?module['"]\s*\)/g;
const STUB = `Promise.resolve({ createRequire: () => () => { throw new Error("require() is not available in the browser build of @babylonjs/lite"); } })`;

export function stripManifoldNodeRequire(): Plugin {
    return {
        name: "strip-manifold-node-require",
        enforce: "pre",
        transform(code, id) {
            const path = id.split("?")[0] ?? id;
            if (!MANIFOLD_ENTRY.test(path)) {
                return null;
            }
            NODE_MODULE_IMPORT.lastIndex = 0;
            if (!NODE_MODULE_IMPORT.test(code)) {
                this.error('strip-manifold-node-require: manifold-3d/manifold.js no longer contains an `import("module")` call — the Emscripten glue changed. Re-verify the browser Node-builtin handling and update this plugin.');
            }
            return { code: code.replace(NODE_MODULE_IMPORT, STUB), map: null };
        },
    };
}
