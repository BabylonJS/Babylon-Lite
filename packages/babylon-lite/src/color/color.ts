/** Convert linear [0,1] to sRGB [0,255] using the IEC 61966-2-1 transfer curve. */
export function linearToSrgbByte(v: number): number {
    const c = Math.max(0, Math.min(1, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
}
