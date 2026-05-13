/** Bake an `R_x(π)` ("flip-Y/Z") orientation correction into a parsed
 *  Gaussian-Splatting asset.
 *
 *  ## Why we need this
 *
 *  Assets exported by the PlayCanvas / SuperSplat / Niantic toolchains
 *  (SOG, SPZ, and several compressed-PLY flavours) are authored in a frame
 *  where "up" is `-Y`. The BJS reference renderer compensates for this at
 *  the scene-graph level: every BJS playground for these formats sets
 *  `mesh.rotation.x = Math.PI` after the asset finishes loading. That is
 *  cosmetic — it is *not* part of the file format — but skipping it leaves
 *  the cloud upside-down.
 *
 *  Babylon-Lite favours "what the user gets is what the file describes",
 *  so we instead bake the same `R_x(π)` rotation into the row buffer +
 *  spherical-harmonics coefficients at load time. The returned mesh then
 *  renders upright with `splat.rotation = (0, 0, 0)`.
 *
 *  ## Equivalence with `mesh.rotation.x = Math.PI`
 *
 *  Under `R_x(π)`: `(x, y, z) → (x, −y, −z)`. For each splat we apply:
 *
 *  - **Position floats** (row offsets 0..11): negate `y` and `z`.
 *  - **Quaternion bytes** (row offsets 28..31, BJS-quantised, stored
 *    `[W, X, Y, Z]`): pre-multiply the *decoded* quaternion by
 *    `q_x(π) = (0, 1, 0, 0)`. After accounting for Lite's split-of-sign
 *    convention in {@link splat-data.ts} (which decodes the row quat as
 *    `(-w, x, -y, z)` to mimic BJS's built-in `scaling.y = -1`), the
 *    byte-level transform is `(W, X, Y, Z) → (X, 255-W, Z, 255-Y)`.
 *    Sign-flipping a BJS-biased uint8 is `byte → 255 - byte`.
 *  - **SH coefficients** (flat `Uint8Array`, BJS-quantised, layout
 *    `[R0, G0, B0, R1, G1, B1, …]` per splat with
 *    `N = (shDegree+1)² − 1` vectors per splat): apply the Wigner-D
 *    rotation of `R_x(π)`, which is diagonal in the standard real-SH
 *    basis. The diagonal entries are ±1 per coefficient, with the sign
 *    given by:
 *
 *    > A basis function `Y_l^m` flips iff one of the following holds:
 *    >   - `m > 0` and `(l + m)`   is odd, or
 *    >   - `m < 0` and `(l + |m|)` is even, or
 *    >   - `m = 0` and `l`         is odd.
 *
 *    Equivalently, flip iff the polynomial Cartesian form of `Y_l^m` has
 *    an odd total power in `y + z` (the two axes that `R_x(π)` negates).
 *    For each "flip" coefficient we set `byte ← 255 − byte` on each of
 *    its three RGB channels.
 *
 *  ## Caveats
 *
 *  - `mesh.splatsData` will return the **corrected** row buffer, not the
 *    raw bytes that came out of the `.sog` / `.spz` file. Anyone
 *    round-tripping the data through `updateData` will therefore preserve
 *    the corrected orientation, not the asset's original orientation.
 *  - Only loaders that opt in (currently {@link loadSOG} and
 *    {@link loadSPZ}) apply this correction. The `.splat` loader and the
 *    compressed-PLY loader leave the data untouched — those formats have
 *    no consistent convention about which way is up.
 */

import type { ParsedSplat } from "./splat-data.js";

const ROW_LENGTH = 32;

/** `Y_l^m` parity table under `R_x(π)`.
 *
 *  Entry `k` corresponds to the `k`-th SH vector (post-DC, i.e. the same
 *  ordering BJS uses in its rest coefficients: `(l=1, m=-1), (l=1, m=0),
 *  (l=1, m=+1), (l=2, m=-2), …`). `1` means the coefficient changes sign
 *  under `R_x(π)`; `0` means it is invariant.
 *
 *  Derivation. For real SH `Y_l^m`:
 *
 *  - `m > 0`: `Y_l^m ∝ P_l^m(cos θ)·cos(m φ)`. Under `y → -y` we have
 *    `φ → -φ`, so `cos(m φ)` is invariant; under `z → -z` we pick up
 *    `(-1)^{l+m}` from the associated Legendre. → flip iff `l + m` odd.
 *  - `m < 0`: `Y_l^m ∝ P_l^{|m|}(cos θ)·sin(|m| φ)`. `sin(|m| φ)` flips,
 *    `P_l^{|m|}` picks up `(-1)^{l+|m|}`. Total `(-1)^{l+|m|+1}`.
 *    → flip iff `l + |m|` even.
 *  - `m = 0`: `Y_l^0 ∝ P_l(cos θ)` only depends on `z`. → flip iff `l`
 *    odd. (Note: this case is *not* the `m<0` formula at `|m|=0` — the
 *    extra "−1" from the missing `sin` factor only exists for `m≠0`.) */
function buildShFlipMask(shDegree: number): Uint8Array {
    const vectorCount = (shDegree + 1) * (shDegree + 1) - 1;
    const mask = new Uint8Array(vectorCount);
    let idx = 0;
    for (let l = 1; l <= shDegree; l++) {
        for (let m = -l; m <= l; m++) {
            let flip: boolean;
            if (m === 0) {
                flip = (l & 1) === 1;
            } else if (m < 0) {
                flip = ((l + (-m)) & 1) === 0;
            } else {
                flip = ((l + m) & 1) === 1;
            }
            mask[idx++] = flip ? 1 : 0;
        }
    }
    return mask;
}

/** Mutate `parsed` in-place to apply an `R_x(π)` up-axis correction.
 *
 *  This bakes the equivalent of a `mesh.rotation.x = Math.PI` rotation
 *  directly into the row buffer and SH coefficients, so the returned mesh
 *  renders upright with no scene-graph rotation required. See the module
 *  header for the full derivation. */
export function applyUpAxisCorrection(parsed: ParsedSplat): void {
    const u8 = new Uint8Array(parsed.data);
    const f32 = new Float32Array(parsed.data);
    const splatCount = (u8.byteLength / ROW_LENGTH) | 0;

    for (let i = 0; i < splatCount; i++) {
        const fi = i * 8;
        const bi = i * ROW_LENGTH;

        // Position: (x, y, z) → (x, -y, -z).
        f32[fi + 1] = -f32[fi + 1]!;
        f32[fi + 2] = -f32[fi + 2]!;

        // Quaternion bytes (BJS-quantised, stored [W, X, Y, Z]):
        // pre-multiply the decoded quat by q_x(π) = (0, 1, 0, 0); see
        // module header for the byte-level derivation.
        const w = u8[bi + 28]!;
        const x = u8[bi + 29]!;
        const y = u8[bi + 30]!;
        const z = u8[bi + 31]!;
        u8[bi + 28] = x;
        u8[bi + 29] = 255 - w;
        u8[bi + 30] = z;
        u8[bi + 31] = 255 - y;
    }

    if (parsed.sh && parsed.shDegree) {
        const sh = parsed.sh;
        const mask = buildShFlipMask(parsed.shDegree);
        const vectorCount = mask.length;
        const stride = vectorCount * 3;
        for (let i = 0; i < splatCount; i++) {
            const base = i * stride;
            for (let k = 0; k < vectorCount; k++) {
                if (mask[k] === 0) {
                    continue;
                }
                const o = base + k * 3;
                sh[o + 0] = 255 - sh[o + 0]!;
                sh[o + 1] = 255 - sh[o + 1]!;
                sh[o + 2] = 255 - sh[o + 2]!;
            }
        }
    }
}
