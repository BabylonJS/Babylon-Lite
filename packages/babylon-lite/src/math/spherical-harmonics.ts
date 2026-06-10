import { F32 } from "../engine/typed-arrays.js";
/**
 * Shared SH → SphericalPolynomial conversion.
 *
 * Converts 9-band (L0–L2) spherical harmonic coefficients in channel-major
 * layout into the 27-float polynomial form used by the BJS
 * SphericalPolynomial.FromHarmonics convention.
 *
 * Input layout (Float64Array, 27 entries):
 *   sh[ch * 9 + band]  where ch ∈ `{0=R, 1=G, 2=B}`, band ∈ 0..8
 *   Band order: L00, L1_-1, L10, L11, L2_-2, L2_-1, L20, L21, L22
 *   Standard (positive) SH basis — no Condon-Shortley negation.
 *
 * Output layout (Float32Array, 27 entries):
 *   poly[field * 3 + ch]  where field ∈ `{x,y,z,xx,yy,zz,yz,zx,xy}`
 */
export function shToPolynomial(sh: Float64Array): Float32Array {
    const invPI = 1 / Math.PI;
    const poly = new F32(27);
    for (let ch = 0; ch < 3; ch++) {
        const o = ch * 9;
        const L00 = sh[o]!,
            L1_1 = sh[o + 1]!,
            L10 = sh[o + 2]!,
            L11 = sh[o + 3]!;
        const L2_2 = sh[o + 4]!,
            L2_1 = sh[o + 5]!,
            L20 = sh[o + 6]!,
            L21 = sh[o + 7]!,
            L22 = sh[o + 8]!;

        poly[0 * 3 + ch] = L11 * 1.02333 * invPI; // x
        poly[1 * 3 + ch] = L1_1 * 1.02333 * invPI; // y
        poly[2 * 3 + ch] = L10 * 1.02333 * invPI; // z
        poly[3 * 3 + ch] = (L00 * 0.886227 - L20 * 0.247708 + L22 * 0.429043) * invPI; // xx
        poly[4 * 3 + ch] = (L00 * 0.886227 - L20 * 0.247708 - L22 * 0.429043) * invPI; // yy
        poly[5 * 3 + ch] = (L00 * 0.886227 + L20 * 0.495417) * invPI; // zz
        poly[6 * 3 + ch] = L2_1 * 0.858086 * invPI; // yz
        poly[7 * 3 + ch] = L21 * 0.858086 * invPI; // zx
        poly[8 * 3 + ch] = L2_2 * 0.858086 * invPI; // xy
    }
    return poly;
}
