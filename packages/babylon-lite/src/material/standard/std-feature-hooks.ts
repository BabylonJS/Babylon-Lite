/**
 * Internal fold-state for the Standard material's deform/vertex + explicit-tangent features.
 *
 * This module holds the module-local state and its setters and is **only ever named-imported**
 * (never namespace-imported / re-exported through a dynamically `await import()`-ed chunk). That is
 * the whole point: `standard-renderable.ts` and `normal-map-fragment.ts` are loaded via dynamic
 * namespace imports (`await import("./standard-renderable.js")`, `mod.bumpStdExt`), so Rollup must
 * retain ALL of their exports. If the setters below lived there, terser could never prove the state
 * stays at its initializer, and every gated branch would ship into scenes that don't use the feature.
 *
 * By keeping the setters here — imported by name into `standard-renderable`/`normal-map-fragment`
 * for READING the state, and imported by name into the dynamic feature chunks for WRITING it — a
 * scene that loads no feature chunk has no reachable caller of a setter. Terser then proves the
 * state constant and folds the feature-OR, the vertex-buffer binder loop, and the tangent path out
 * entirely (true byte-neutrality), exactly like the stencil resolver hook.
 */

import type { ShaderFragment } from "../../shader/fragment-types.js";

/** Active deform/vertex StdExt feature bits. Each dynamic feature chunk (std-vertex-color / morph /
 *  skeleton / normal-tangent fragment) ORs its `HAS_*` bit in via `_installStdExtFeature` on import. */
export let _stdExtBits = 0;
/** @internal OR a deform/vertex feature bit into the active set (called by feature chunks on load). */
export function _installStdExtFeature(bit: number): void {
    _stdExtBits |= bit;
}

/** Explicit-tangent normal-map fragment factory, injected by `std-normal-tangent-fragment.ts` on
 *  import. Stays `null` (and every tangent branch folds) until that chunk loads. */
export let _tangentFrag: ((features: number) => ShaderFragment) | null = null;
/** @internal Install the explicit-tangent normal-map fragment factory (called by the tangent chunk). */
export function _installNormalTangentFrag(frag: (features: number) => ShaderFragment): void {
    _tangentFrag = frag;
}
