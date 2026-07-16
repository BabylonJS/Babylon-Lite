/** Shadow-only PBR material opt-in.
 *
 *  Statically imports the shadow-only fragment's `pbrExt`, so the fragment plus its
 *  registration wiring are bundled only when an app imports `setShadowOnly`. Scenes
 *  that never call it pay zero base-chunk bytes — there is no always-loaded scan for
 *  `shadowOnly` and no `import("./fragments/shadow-only-fragment.js")` specifier in
 *  the renderable's shared chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/shadow-only-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Options for {@link setShadowOnly}. */
export interface ShadowOnlyOptions {
    /** Linear-RGB color shown where the shadow falls. Default black (`[0, 0, 0]`). */
    color?: [number, number, number];
    /** Maximum opacity at the darkest part of the shadow, range [0, 1]. Default 1.0. */
    opacity?: number;
    /** Falloff sharpness for the shadow's soft edges. Default 1.0. Higher values steepen
     *  the falloff, giving crisper visible edges. */
    falloff?: number;
}

/** Turn `mat` into a shadow-only receiver: the surface is invisible except where a
 *  shadow is cast on it, where it appears in `options.color` (black by default).
 *  Mirrors BJS `BackgroundMaterial.shadowOnly`. Requires `receiveShadows` on the mesh
 *  and at least one shadow-casting light. Call on the material returned by
 *  `createPbrMaterial` (or on the props before creating it). */
export function setShadowOnly(mat: Partial<PbrMaterialProps>, options?: ShadowOnlyOptions): void {
    mat.shadowOnly = true;
    if (options?.color) {
        mat.shadowOnlyColor = options.color;
    }
    if (options?.opacity !== undefined) {
        mat.shadowOnlyOpacity = options.opacity;
    }
    if (options?.falloff !== undefined) {
        mat.shadowOnlyFalloff = options.falloff;
    }
    // Register globally (idempotent, keyed by id). The PBR registry is a persistent
    // per-runtime Map that the drain in buildPbrRenderables already populates the same
    // way, so registering here is consistent — and it means the renderable's shared
    // chunk carries no shadow-only scan or import specifier. The ext's `detect` hook
    // gates every hot path on `mat.shadowOnly`, so materials that never opt in are
    // untouched.
    _registerPbrExt(pbrExt);
}
