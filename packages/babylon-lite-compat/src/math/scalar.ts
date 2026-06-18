/** Babylon.js-compatible scalar helpers and a small set of math constants. */

export const Epsilon = 0.001;
export const ToRadians = Math.PI / 180;
export const ToDegrees = 180 / Math.PI;

/** Babylon.js `Scalar` namespace — common scalar utilities. */
export const Scalar = {
    Clamp(value: number, min = 0, max = 1): number {
        return Math.min(max, Math.max(min, value));
    },
    Lerp(start: number, end: number, amount: number): number {
        return start + (end - start) * amount;
    },
    InverseLerp(a: number, b: number, value: number): number {
        return a === b ? 0 : (value - a) / (b - a);
    },
    DegreesToRadians(degrees: number): number {
        return degrees * ToRadians;
    },
    RadiansToDegrees(radians: number): number {
        return radians * ToDegrees;
    },
    WithinEpsilon(a: number, b: number, epsilon = 1.401298e-45): boolean {
        return Math.abs(a - b) <= epsilon;
    },
    Normalize(value: number, min: number, max: number): number {
        return (value - min) / (max - min);
    },
    Denormalize(normalized: number, min: number, max: number): number {
        return normalized * (max - min) + min;
    },
};
