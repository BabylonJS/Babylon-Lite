// Shared, deterministic morph deformation for scene 252 (StandardMaterial morph).
//
// The delta for each vertex is a pure function of its base position, so Lite and
// the Babylon.js reference produce identical morphed geometry regardless of
// vertex ordering. The base sphere has diameter 1 (radius 0.5).

/** Morph influence baked into the scene (fully applied, frozen for determinism). */
export const SCENE252_MORPH_WEIGHT = 1;

/** Position deltas turning the base sphere into a vertically stretched, top-pinched teardrop. */
export function scene252MorphDeltas(basePositions: Float32Array): Float32Array {
    const deltas = new Float32Array(basePositions.length);
    for (let i = 0; i < basePositions.length; i += 3) {
        const x = basePositions[i]!;
        const y = basePositions[i + 1]!;
        const z = basePositions[i + 2]!;
        const upper = Math.max(0, y) / 0.5; // 0..1 across the upper hemisphere (radius 0.5)
        deltas[i] = -x * 0.45 * upper; // pinch the top inward
        deltas[i + 1] = 0.5 * y; // elongate vertically
        deltas[i + 2] = -z * 0.45 * upper;
    }
    return deltas;
}
