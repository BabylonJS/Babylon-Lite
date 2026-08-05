/**
 * Stud Material Plugin — local-top stud faces for thin-instanced Parts
 * .
 *
 * A public-API `MaterialPlugin` on the shared Part standard material.
 * Studs belong to the part's local top face and
 * tilt with the part (R/T rotation), they don't jump to whichever face points
 * up.
 *
 * How: the renderer encodes "which world-axis face is the part's local top"
 * (0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z) into the unused instance-color alpha as
 * `(index + 0.5) / 8`; index >= 6 means no studs.
 * Parts render opaque on an opaque canvas, so output
 * alpha is a free channel. The fragment decodes the face, samples the stud
 * tiles in that face's world plane (repeat addressing, no `fract()` — smooth
 * derivatives, clean mips, one stud texel per world stud), modulates
 * `baseColor`, and swaps the lighting normal for the stud normal map on that
 * face only. Other faces stay flat per-instance color.
 *
 * Rotation steps are 90°, so the local top always maps to a world axis and
 * the per-face tangent tables below are exact.
 */

import type { MaterialPlugin } from "babylon-lite";

import type { StudTextures } from "./stud-texture.js";

/**
 * Per-face frames: worldN = T·n.x + B·n.y + N·n.z, uv = (vp·T, vp·B).
 * Top face (+Y) uses T=+X, B=+Z so uv = vp.xz — same orientation the
 * baseplate bump path consumes (green → +Z).
 */
const FRAGMENT_AC = `
var studT = array<vec3<f32>, 6>(vec3<f32>(0.,0.,1.), vec3<f32>(0.,0.,1.), vec3<f32>(1.,0.,0.), vec3<f32>(1.,0.,0.), vec3<f32>(1.,0.,0.), vec3<f32>(1.,0.,0.));
var studB = array<vec3<f32>, 6>(vec3<f32>(0.,1.,0.), vec3<f32>(0.,1.,0.), vec3<f32>(0.,0.,1.), vec3<f32>(0.,0.,1.), vec3<f32>(0.,1.,0.), vec3<f32>(0.,1.,0.));
var studN = array<vec3<f32>, 6>(vec3<f32>(1.,0.,0.), vec3<f32>(-1.,0.,0.), vec3<f32>(0.,1.,0.), vec3<f32>(0.,-1.,0.), vec3<f32>(0.,0.,1.), vec3<f32>(0.,0.,-1.));
let studFaceRaw = u32(input.vInstanceColor.a * 8.0);
let studsOn = select(0.0, 1.0, studFaceRaw < 6u);
let studFace = min(studFaceRaw, 5u);
let sT = studT[studFace];
let sB = studB[studFace];
let sN = studN[studFace];
let studUv = vec2<f32>(dot(input.vp, sT), dot(input.vp, sB));
let studTexel = textureSample(studDT, studDS, studUv);
let studTan = textureSample(studNT, studNS, studUv).xyz * 2.0 - 1.0;
let studIsTop = step(0.995, dot(normalW, sN)) * studsOn;
let studWorldN = normalize(sT * studTan.x + sB * studTan.y + sN * studTan.z);
normalW = normalize(mix(normalW, studWorldN, studIsTop));
`;

const FRAGMENT_AT = `
baseColor = baseColor * mix(vec3<f32>(1.0), studTexel.rgb, studIsTop);
`;

/** Create the stud plugin bound to a generated stud texture pair. */
export function createStudMaterialPlugin(studs: StudTextures): MaterialPlugin {
    return {
        name: "sandblox-studs",
        getSamplers: () => [
            { texture: "studDT", sampler: "studDS" },
            { texture: "studNT", sampler: "studNS" },
        ],
        getCustomCode: (shaderType) =>
            shaderType === "fragment"
                ? {
                      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: FRAGMENT_AC,
                      CUSTOM_FRAGMENT_UPDATE_ALPHA: FRAGMENT_AT,
                  }
                : null,
        bindTextures: (out) => {
            out.push({ texture: studs.baseColor }, { texture: studs.normalMap });
        },
        getActiveTextures: (out) => {
            out.push(studs.baseColor, studs.normalMap);
        },
    };
}
