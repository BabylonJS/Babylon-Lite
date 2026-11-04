/** Round `n` up to the nearest multiple of `to` (must be a positive integer). */
export function align(n: number, to: number): number {
    return Math.ceil(n / to) * to;
}
