import type { StandardMaterialProps } from "./standard-material.js";
import type { ParallaxOcclusionProps } from "../parallax/parallax-occlusion.js";
import { _copyParallaxOcclusionProps } from "../parallax/parallax-occlusion.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdParallaxOcclusionExt } from "./fragments/std-parallax-occlusion-fragment.js";

/** Enable independent contact-refinement POM on Standard surface textures, or disable it with null.
 * Call before registerScene(); later changes require rebuildMaterial().
 * Existing bump-map frames, mesh depth, and shadow casting are unchanged. */
export function setStandardParallaxOcclusion(material: StandardMaterialProps, props: ParallaxOcclusionProps | null): void {
    const state = props === null ? undefined : _copyParallaxOcclusionProps(props);
    material._parallaxOcclusion = state;
    _registerStdExt(stdParallaxOcclusionExt);
}
