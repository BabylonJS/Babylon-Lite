/** Bump/normal-map Standard material opt-in.
 *
 *  Statically imports the normal-map ext, so its WGSL, bind entries and feature
 *  detection only bundle when an app imports `setStandardBumpTexture`. Previously a
 *  dispatch table in the group builder held a `() => import(...)` for this and seven
 *  sibling fragments, putting eight chunk references in the entry chunk of EVERY scene
 *  using a StandardMaterial — including the ~82 lab scenes that use none of them.
 *
 *  The backing field is `@internal _bumpTexture` rather than a public `bumpTexture`
 *  property on purpose: with a plain property, assigning it without also registering the
 *  ext would leave the texture unsampled (a silent no-op). Making it internal turns that
 *  mistake into a compile error and leaves this setter as the one way in. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { bumpStdExt } from "./fragments/normal-map-fragment.js";

/** Set the bump/normal-map texture on `mat`. Uses a cotangent frame, so the mesh needs
 *  no tangent attribute. Perturbation strength is controlled by `mat.bumpLevel`
 *  (default 1.0). Registers the normal-map extension globally (idempotent). Call before
 *  the scene is first built. */
export function setStandardBumpTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._bumpTexture = texture;
    _registerStdExt(bumpStdExt);
}
