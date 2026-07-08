import type { Color4 } from "./types.js";

/** Copy `src` into `dst` (in place). */
export function copyColor4(dst: Color4, src: Color4): Color4 {
    dst.r = src.r;
    dst.g = src.g;
    dst.b = src.b;
    dst.a = src.a;
    return dst;
}

/** Multiply every channel of `src` by scalar `s` into `out`. */
export function scaleColor4ToRef(src: Color4, s: number, out: Color4): Color4 {
    out.r = src.r * s;
    out.g = src.g * s;
    out.b = src.b * s;
    out.a = src.a * s;
    return out;
}
