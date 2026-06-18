/**
 * No-op stand-in for `@recast-navigation/core` / `@recast-navigation/generators`
 * inside the compat (`?compat`) subtree.
 *
 * Babylon.js navigation scenes import the raw `@recast-navigation` packages, call
 * `init()`, and pass `{ ...RecastCore, ...RecastGenerators }` into
 * `CreateNavigationPluginAsync({ instance })`. The compat navigation wrapper
 * ([navigation/navigation.ts](navigation.ts)) ignores that injected instance and
 * drives Babylon Lite's own navigation API (which loads its own Recast wasm), so
 * the scene's direct Recast usage is reduced to a harmless no-op here — avoiding a
 * second wasm download.
 */

/** Babylon.js scenes call `await RecastCore.init()`; Lite loads Recast itself, so no-op. */
export async function init(): Promise<void> {
    // Intentionally empty — Babylon Lite's navigation plugin loads Recast internally.
}

// `{ ...RecastCore }` / `{ ...RecastGenerators }` spreads collect nothing else of use;
// the compat navigation wrapper does not read the injected instance.
