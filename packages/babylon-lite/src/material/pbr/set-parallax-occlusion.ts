import type { PbrMaterialProps } from "./pbr-material.js";
import type { ParallaxOcclusionProps } from "../parallax/parallax-occlusion.js";
import { _copyParallaxOcclusionProps } from "../parallax/parallax-occlusion.js";
import { _registerPbrExt } from "./pbr-flags.js";
import { pbrParallaxOcclusionExt } from "./fragments/parallax-occlusion-fragment.js";

/** Enable independent contact-refinement POM, or disable it with null.
 * Call before registerScene(); texture or active-variant changes require rebuildMaterial().
 * Scalar updates to an already-active variant can use markMaterialUboDirty().
 * Existing normal maps are sampled at displaced UVs; mesh depth is unchanged. */
export function setPbrParallaxOcclusion(material: PbrMaterialProps, props: ParallaxOcclusionProps | null): void {
    const state = props === null ? undefined : _copyParallaxOcclusionProps(props);
    material._parallaxOcclusion = state;
    _registerPbrExt(pbrParallaxOcclusionExt);
}
