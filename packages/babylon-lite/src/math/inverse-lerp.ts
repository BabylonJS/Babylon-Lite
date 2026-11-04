/** Return the parameter of `value` between either-ordered endpoints, clamped to [0, 1]; identical endpoints return 0. */
export function inverseLerp(a: number, b: number, value: number): number {
    return a === b ? 0 : Math.min(1, Math.max(0, (value - a) / (b - a)));
}
