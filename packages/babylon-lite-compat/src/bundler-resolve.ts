/**
 * Shared Babylon.js → `@babylonjs/lite-compat` import-mapping table.
 *
 * This is the single source of truth used by every bundler adapter
 * ([vite.ts](vite.ts), [rollup.ts](rollup.ts), [webpack.ts](webpack.ts),
 * [esbuild.ts](esbuild.ts)) and by the lab's side-by-side dev harness
 * ([../../../lab/vite.config.ts](../../../lab/vite.config.ts)), so the redirect
 * rules can never drift between them. It is a pure, dependency-free mapping,
 * which keeps it trivially unit-testable.
 */

/** The compat module category a Babylon.js import is redirected onto. */
export type CompatTarget = "core" | "addons" | "recast" | "materials";

/**
 * Map a Babylon.js (or Recast) import specifier onto the compat module category
 * that replaces it, or `null` when the specifier is not remapped.
 *
 * - `@babylonjs/core` / `@babylonjs/loaders` — bare, deep subpaths, and
 *   side-effect-only imports → `"core"` (the compat barrel).
 * - `@babylonjs/addons` — bare or any subpath → `"addons"` (compat navigation
 *   wrapper over Babylon Lite's native Recast API; navigation is the only addon
 *   currently implemented).
 * - `@recast-navigation/core` / `@recast-navigation/generators` → `"recast"`
 *   (no-op shim; Lite loads its own Recast wasm).
 * - `@babylonjs/materials` — bare or any subpath → `"materials"` (the compat
 *   barrel, which re-exports `GridMaterial`; grid is the only material currently
 *   implemented).
 */
export function mapBabylonImport(source: string): CompatTarget | null {
    if (/^@babylonjs\/(core|loaders)(\/|$)/.test(source)) {
        return "core";
    }
    if (/^@babylonjs\/addons(\/|$)/.test(source)) {
        return "addons";
    }
    if (/^@recast-navigation\/(core|generators)(\/|$)/.test(source)) {
        return "recast";
    }
    if (/^@babylonjs\/materials(\/|$)/.test(source)) {
        return "materials";
    }
    return null;
}

/**
 * Public `@babylonjs/lite-compat` specifier each redirect category resolves to.
 * Returning bare specifiers (rather than absolute paths) defers resolution to
 * the package's own `exports` map, so the adapters work whether the package is
 * consumed from source (this monorepo) or from its published `dist` build, and
 * across every bundler's native resolver.
 */
const COMPAT_SPECIFIER: Record<CompatTarget, string> = {
    core: "@babylonjs/lite-compat",
    addons: "@babylonjs/lite-compat/navigation",
    recast: "@babylonjs/lite-compat/recast-shim",
    // `GridMaterial` is re-exported from the root barrel, so the materials
    // redirect folds into the main entry rather than carrying its own subpath.
    materials: "@babylonjs/lite-compat",
};

/**
 * Resolve a Babylon.js (or Recast) import specifier to the bare
 * `@babylonjs/lite-compat` specifier that replaces it, or `null` when the
 * specifier is not remapped. Each bundler adapter feeds the returned specifier
 * back into that bundler's own resolver to obtain the final on-disk module.
 */
export function resolveCompatSpecifier(source: string): string | null {
    const target = mapBabylonImport(source);
    return target ? COMPAT_SPECIFIER[target] : null;
}

/**
 * Broad prefix matcher for the specifiers any adapter might remap. Bundlers that
 * filter by `RegExp` (Webpack, esbuild) use this to narrow the hook to plausible
 * candidates; `resolveCompatSpecifier` then makes the precise decision (and
 * returns `null` for non-matches such as `@babylonjs/gui`).
 */
export const COMPAT_SOURCE_FILTER = /^@babylonjs\/|^@recast-navigation\//;
