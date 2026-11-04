/**
 * Babylon.js `Scalar.RandomRange` semantics: returns `min` **without consuming a random** when
 * `min === max`, otherwise `Math.random() * (max - min) + min`.
 *
 * The short-circuit matters for deterministic parity — callers that draw one random per component
 * (such as particle emitter shapes) rely on equal min/max bounds not advancing the seeded RNG
 * sequence.
 */
export function randomRange(min: number, max: number): number {
    if (min === max) {
        return min;
    }
    return Math.random() * (max - min) + min;
}
