/**
 * Shadow-Only Fragment.
 *
 * Mirrors BJS `BackgroundMaterial.shadowOnly`: the surface is invisible except
 * where shadow falls on it. Unshadowed fragments output alpha=0 (fully
 * transparent); shadowed fragments output alpha proportional to the shadow
 * strength, in a caller-chosen `shadowOnlyColor` (defaults to black).
 *
 * Zero bytes in bundles for scenes that don't use shadow-only materials — the
 * module is dynamically imported by pbr-renderable only when at least one mesh
 * in the scene has `mat.shadowOnly === true`.
 *
 * Implementation notes
 * --------------------
 * A shadow-only mesh sets `receiveShadows = true`, which forces the multi-light
 * PBR path (lightMode = 2). That path declares
 * `var shadowFactors: array<f32, MAX_LIGHTS>` (all entries initialised to 1.0 =
 * no shadow) at fragment-main
 * scope and the shadow fragment writes the real shadow factor into
 * `shadowFactors[lightIndex]` for each shadow-casting light.
 *
 * In the BC slot (just before the alpha-blend block, after the color path) we
 * override the final color with `shadowOnlyColor` and override `alpha` with the
 * shadow term so the surface is opaque where shadow is and transparent where it
 * isn't.
 *
 * The alpha-blend block then folds `luminanceOverAlpha` (direct + IBL specular
 * luminance) into `finalAlpha`, which would make a shadow catcher opaque
 * wherever the environment reflects in it. `finalSpecularScaled` /
 * `finalRadianceScaled` are immutable `let`s at that point, so we cannot zero
 * them from BC. Instead we inject the `FA` slot (emitted just before the alpha
 * return) to overwrite `finalAlpha` with the pure shadow term, bypassing the
 * luminance bleed entirely. The `FA` marker costs nothing in shaders that don't
 * load this fragment.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_ALPHA_BLEND } from "../pbr-flags.js";
import { MAX_LIGHTS } from "../../../light/types.js";

// Feature2 bit local to this lazy module (see pbr-flag-bits.ts): never retained
// in the entry/shared chunk for scenes that don't load this fragment.
const PBR2_HAS_SHADOW_ONLY = 1 << 30;

/**
 * Create a shadow-only fragment that overrides color/alpha at the BC injection point.
 *
 * Unrolls a `min()` across the local `shadowFactors` array (declared by the
 * multi-light block) to compute the strongest shadow term, then overwrites
 * `color` and `alpha` with the shadow-only outputs.
 */
export function createShadowOnlyFragment(): ShaderFragment {
    const unrolled: string[] = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
        unrolled.push(`so_shadowMin = min(so_shadowMin, shadowFactors[${i}]);`);
    }
    const bc = `
{
var so_shadowMin = 1.0;
${unrolled.join("\n")}
color = material.shadowOnlyColor;
alpha = saturate((1.0 - so_shadowMin) * material.shadowOnlyFalloff) * material.shadowOnlyOpacity;
}
`;

    return {
        _id: "shadow-only",
        _uboFields: [
            { _name: "shadowOnlyColor", _type: "vec3<f32>" },
            { _name: "shadowOnlyOpacity", _type: "f32" },
            { _name: "shadowOnlyFalloff", _type: "f32" },
        ],
        _fragmentSlots: {
            BC: bc,
            // Overwrite finalAlpha after the alpha block's luminanceOverAlpha fold so
            // environment/direct specular can't make the shadow catcher opaque. `alpha`
            // holds the shadow term set in BC.
            FA: `finalAlpha = alpha * material.materialAlpha;`,
        },
    };
}

/** Write the shadow-only material-UBO slice. */
export function writeShadowOnlyUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    if (!material.shadowOnly) {
        return;
    }
    if (offsets.has("shadowOnlyColor")) {
        const off = offsets.get("shadowOnlyColor")! / 4;
        const tint = material.shadowOnlyColor ?? [0, 0, 0];
        data[off] = tint[0]!;
        data[off + 1] = tint[1]!;
        data[off + 2] = tint[2]!;
    }
    if (offsets.has("shadowOnlyOpacity")) {
        data[offsets.get("shadowOnlyOpacity")! / 4] = material.shadowOnlyOpacity ?? 1.0;
    }
    if (offsets.has("shadowOnlyFalloff")) {
        data[offsets.get("shadowOnlyFalloff")! / 4] = material.shadowOnlyFalloff ?? 1.0;
    }
}

export const pbrExt: PbrExt = {
    id: "shadow-only",
    phase: "fragment",
    detect(mat) {
        // Force PBR_HAS_ALPHA_BLEND so the shadow catcher composites as a transparent
        // surface regardless of whether the caller set `alpha`/`alphaBlend`. This is
        // required for correctness: (1) `isTransparent` in pbr-renderable keys off
        // PBR_HAS_ALPHA_BLEND to admit the mesh into the transparent pass with GPU
        // blending, and (2) the `/*FA*/` slot this fragment injects only exists in the
        // template's alpha-blend branch. The bit lives in the shared chunk already, so
        // forcing it here adds no bytes to scenes that never load this fragment.
        return (mat as PbrMaterialProps).shadowOnly ? { f: PBR_HAS_ALPHA_BLEND, f2: PBR2_HAS_SHADOW_ONLY } : { f: 0, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx._features2 & PBR2_HAS_SHADOW_ONLY)) {
            return null;
        }
        return createShadowOnlyFragment();
    },
    writeUbo: writeShadowOnlyUBO as PbrExt["writeUbo"],
};
