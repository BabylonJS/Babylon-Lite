/** Canonical SceneUniforms field list — single source of truth for the
 *  per-pass scene UBO struct shared by Standard, PBR, and any future
 *  material family.
 *
 *  The struct unifies what was previously two separate layouts (std + pbr)
 *  by including ALL fields any material may need. Unused fields stay zero
 *  in writers that don't care about them; consumers that don't need them
 *  simply don't reference them in WGSL.
 *
 *  Light slots are a *union* — directional/hemispheric lights write
 *  `lightDirection` + `lightDiffuseColor` (+ `lightGroundColor` for hemi);
 *  point lights write `lightPosition` + `lightDiffuseColor` + `lightRange`.
 *  Each light extension reads only the fields its type cares about.
 */

import type { UboField } from "./fragment-types.js";
import { computeUboLayout } from "./ubo-layout.js";

export const SCENE_UBO_FIELDS: readonly UboField[] = [
    // ── Camera ─────────────────────────────────────────────────────
    { name: "viewProjection", type: "mat4x4<f32>" }, // @ 0   (64)
    { name: "view", type: "mat4x4<f32>" }, //            @ 64  (64) — std uses; pbr ignores
    { name: "vEyePosition", type: "vec4<f32>" }, //      @ 128 (16) — .xyz = camera position

    // ── Light slot 0 ───────────────────────────────────────────────
    // directional / hemispheric: write lightDirection + lightDiffuseColor (+ groundColor for hemi)
    // point:                     write lightPosition + lightDiffuseColor + lightRange
    { name: "lightDirection", type: "vec3<f32>" }, //    @ 144 (12) — directional/hemispheric
    { name: "lightIntensity", type: "f32" }, //          @ 156 (4)
    { name: "lightDiffuseColor", type: "vec3<f32>" }, // @ 160 (12)
    { name: "lightRange", type: "f32" }, //              @ 172 (4)  — point lights
    { name: "lightGroundColor", type: "vec3<f32>" }, //  @ 176 (12) — hemispheric
    { name: "_lightPad0", type: "f32" }, //              @ 188 (4)
    { name: "lightPosition", type: "vec3<f32>" }, //     @ 192 (12) — point lights
    { name: "_lightPad1", type: "f32" }, //              @ 204 (4)

    // ── Environment / IBL ──────────────────────────────────────────
    { name: "envRotationY", type: "f32" }, //            @ 208 (4)
    { name: "_envPad0", type: "f32" }, //                @ 212 (4)
    { name: "_envPad1", type: "f32" }, //                @ 216 (4)
    { name: "_envPad2", type: "f32" }, //                @ 220 (4)
    // Spherical harmonics: 9 × (vec3 + f32 pad) = 144 bytes @ 224..368
    { name: "vSphericalL00", type: "vec3<f32>" },
    { name: "_shPad0", type: "f32" },
    { name: "vSphericalL1_1", type: "vec3<f32>" },
    { name: "_shPad1", type: "f32" },
    { name: "vSphericalL10", type: "vec3<f32>" },
    { name: "_shPad2", type: "f32" },
    { name: "vSphericalL11", type: "vec3<f32>" },
    { name: "_shPad3", type: "f32" },
    { name: "vSphericalL2_2", type: "vec3<f32>" },
    { name: "_shPad4", type: "f32" },
    { name: "vSphericalL2_1", type: "vec3<f32>" },
    { name: "_shPad5", type: "f32" },
    { name: "vSphericalL20", type: "vec3<f32>" },
    { name: "_shPad6", type: "f32" },
    { name: "vSphericalL21", type: "vec3<f32>" },
    { name: "_shPad7", type: "f32" },
    { name: "vSphericalL22", type: "vec3<f32>" },
    { name: "_shPad8", type: "f32" },

    // ── Image processing ───────────────────────────────────────────
    { name: "exposureLinear", type: "f32" }, //          @ 368 (4)
    { name: "contrast", type: "f32" }, //                @ 372 (4)
    { name: "lodGenerationScale", type: "f32" }, //      @ 376 (4)
    { name: "_imgPad", type: "f32" }, //                 @ 380 (4)

    // ── Fog (std uses; pbr ignores) ────────────────────────────────
    { name: "vFogInfos", type: "vec4<f32>" }, //         @ 384 (16) — x=mode y=start z=end w=density
    { name: "vFogColor", type: "vec4<f32>" }, //         @ 400 (16)
];

export const SCENE_UBO_SPEC = computeUboLayout(SCENE_UBO_FIELDS);
export const SCENE_UBO_BYTES = SCENE_UBO_SPEC.totalBytes;

/** Canonical WGSL declaration of the SceneUniforms struct + group(0) binding.
 *  Prepend to any shader that samples the per-pass scene UBO. */
export const SCENE_UBO_WGSL = `struct SceneUniforms {\n${SCENE_UBO_SPEC.structBody}\n}\n@group(0) @binding(0) var<uniform> scene: SceneUniforms;\n`;

/** Float-index helpers for direct-write performance (avoids Map.get per write). */
export const SCENE_UBO_OFFSETS = (() => {
    const o = SCENE_UBO_SPEC.offsets;
    return {
        viewProjection: o.get("viewProjection")! / 4,
        view: o.get("view")! / 4,
        vEyePosition: o.get("vEyePosition")! / 4,
        lightDirection: o.get("lightDirection")! / 4,
        lightIntensity: o.get("lightIntensity")! / 4,
        lightDiffuseColor: o.get("lightDiffuseColor")! / 4,
        lightRange: o.get("lightRange")! / 4,
        lightGroundColor: o.get("lightGroundColor")! / 4,
        lightPosition: o.get("lightPosition")! / 4,
        envRotationY: o.get("envRotationY")! / 4,
        vSphericalL00: o.get("vSphericalL00")! / 4,
        exposureLinear: o.get("exposureLinear")! / 4,
        contrast: o.get("contrast")! / 4,
        lodGenerationScale: o.get("lodGenerationScale")! / 4,
        vFogInfos: o.get("vFogInfos")! / 4,
        vFogColor: o.get("vFogColor")! / 4,
    } as const;
})();
