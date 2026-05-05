/** IridescenceBlock — marker for PBR-MR thin-film Fresnel.
 *
 *  The block itself returns an object output in Babylon.js. Lite keeps object
 *  sockets as marker blocks: PBRMetallicRoughnessBlock walks into the connected
 *  IridescenceBlock and reads `intensity`, `indexOfRefraction`, and `thickness`
 *  so only graphs that use iridescence pay for the thin-film helper code.
 */

import type { BlockEmitter } from "../node-types.js";

const IRIDESCENCE_HELPERS = `const NME_PBR_XYZ_TO_REC709: mat3x3<f32> = mat3x3<f32>(
    3.2404542, -0.9692660, 0.0556434,
    -1.5371385, 1.8760108, -0.2040259,
    -0.4985314, 0.0415560, 1.0572252
);
fn nme_pbr_square3(x: vec3<f32>) -> vec3<f32> { return x * x; }
fn nme_pbr_iorFromAirF0(f0: vec3<f32>) -> vec3<f32> {
    let s = sqrt(clamp(f0, vec3<f32>(0.0), vec3<f32>(0.9999)));
    return (vec3<f32>(1.0) + s) / (vec3<f32>(1.0) - s);
}
fn nme_pbr_r0FromIor3(iorT: vec3<f32>, iorI: f32) -> vec3<f32> { return nme_pbr_square3((iorT - vec3<f32>(iorI)) / (iorT + vec3<f32>(iorI))); }
fn nme_pbr_r0FromIor(iorT: f32, iorI: f32) -> f32 { let r = (iorT - iorI) / (iorT + iorI); return r * r; }
fn nme_pbr_evalSensitivity(opd: f32, shift: vec3<f32>) -> vec3<f32> {
    let phase = 6.283185307179586 * opd * 1.0e-9;
    let val = vec3<f32>(5.4856e-13, 4.4201e-13, 5.2481e-13);
    let pos = vec3<f32>(1.6810e+06, 1.7953e+06, 2.2084e+06);
    let vr = vec3<f32>(4.3278e+09, 9.3046e+09, 6.6121e+09);
    var xyz = val * sqrt(6.283185307179586 * vr) * cos(pos * phase + shift) * exp(-(phase * phase) * vr);
    xyz.x = xyz.x + 9.7470e-14 * sqrt(6.283185307179586 * 4.5282e+09) * cos(2.2399e+06 * phase + shift.x) * exp(-4.5282e+09 * phase * phase);
    xyz = xyz / 1.0685e-7;
    return NME_PBR_XYZ_TO_REC709 * xyz;
}
fn nme_pbr_evalIridescence(outsideIor: f32, eta2: f32, cosTheta1: f32, thickness: f32, baseF0: vec3<f32>) -> vec3<f32> {
    let iridescenceIor = mix(outsideIor, eta2, smoothstep(0.0, 0.03, thickness));
    let sinTheta2Sq = ((outsideIor / iridescenceIor) * (outsideIor / iridescenceIor)) * (1.0 - cosTheta1 * cosTheta1);
    let cosTheta2Sq = 1.0 - sinTheta2Sq;
    if (cosTheta2Sq < 0.0) { return vec3<f32>(1.0); }
    let cosTheta2 = sqrt(cosTheta2Sq);
    let r0 = nme_pbr_r0FromIor(iridescenceIor, outsideIor);
    let r12 = nme_pbr_fresSchlick(cosTheta1, vec3<f32>(r0), vec3<f32>(1.0)).x;
    let t121 = 1.0 - r12;
    var phi12 = 0.0;
    if (iridescenceIor < outsideIor) { phi12 = 3.141592653589793; }
    let phi21 = 3.141592653589793 - phi12;
    let baseIor = nme_pbr_iorFromAirF0(baseF0);
    let r1 = nme_pbr_r0FromIor3(baseIor, iridescenceIor);
    let r23 = nme_pbr_fresSchlick(cosTheta2, r1, vec3<f32>(1.0));
    var phi23 = vec3<f32>(0.0);
    if (baseIor.x < iridescenceIor) { phi23.x = 3.141592653589793; }
    if (baseIor.y < iridescenceIor) { phi23.y = 3.141592653589793; }
    if (baseIor.z < iridescenceIor) { phi23.z = 3.141592653589793; }
    let opd = 2.0 * iridescenceIor * thickness * cosTheta2;
    let phi = vec3<f32>(phi21) + phi23;
    let r123 = clamp(vec3<f32>(r12) * r23, vec3<f32>(1e-5), vec3<f32>(0.9999));
    let smallR123 = sqrt(r123);
    let rs = (t121 * t121) * r23 / (vec3<f32>(1.0) - r123);
    var outI = vec3<f32>(r12) + rs;
    var cm = rs - vec3<f32>(t121);
    for (var m: i32 = 1; m <= 2; m = m + 1) {
        cm = cm * smallR123;
        outI = outI + cm * (2.0 * nme_pbr_evalSensitivity(f32(m) * opd, f32(m) * phi));
    }
    return max(outI, vec3<f32>(0.0));
}`;

export const emitter: BlockEmitter = {
    className: "IridescenceBlock",
    stage: "fragment",
    emit(_block, _outputName, _stage, state, _ctx) {
        state.usesIridescence = true;
        state.fragment.helpers.set("nme_pbr_iridescence_helpers", IRIDESCENCE_HELPERS);
        return { expr: `vec3<f32>(0.0)`, type: "vec3f" };
    },
};
