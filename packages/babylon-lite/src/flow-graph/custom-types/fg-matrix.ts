// glTF `float2x2` / `float3x3` matrix types. Core math/ only has 4x4 (`Mat4`),
// so the flow-graph subsystem owns these. Plain `Float32Array`-backed tagged
// objects (no class). Pure helpers only; zero module-level allocation.

/** A 2x2 matrix (glTF `float2x2`), column-major, 4 elements. */
export interface FgMatrix2D {
    readonly m: Float32Array;
    /** @internal Discriminant tag. */
    readonly __fgMat: 2;
}

/** A 3x3 matrix (glTF `float3x3`), column-major, 9 elements. */
export interface FgMatrix3D {
    readonly m: Float32Array;
    /** @internal Discriminant tag. */
    readonly __fgMat: 3;
}

/** Construct an `FgMatrix2D` from 4 column-major elements (defaults to identity). */
export function fgMatrix2D(elements?: ArrayLike<number>): FgMatrix2D {
    const m = new Float32Array(4);
    if (elements) {
        m.set(elements);
    } else {
        m[0] = 1;
        m[3] = 1;
    }
    return { m, __fgMat: 2 };
}

/** Construct an `FgMatrix3D` from 9 column-major elements (defaults to identity). */
export function fgMatrix3D(elements?: ArrayLike<number>): FgMatrix3D {
    const m = new Float32Array(9);
    if (elements) {
        m.set(elements);
    } else {
        m[0] = 1;
        m[4] = 1;
        m[8] = 1;
    }
    return { m, __fgMat: 3 };
}

/** Type guard for `FgMatrix2D`. */
export function isFgMatrix2D(v: unknown): v is FgMatrix2D {
    return typeof v === "object" && v !== null && (v as FgMatrix2D).__fgMat === 2;
}

/** Type guard for `FgMatrix3D`. */
export function isFgMatrix3D(v: unknown): v is FgMatrix3D {
    return typeof v === "object" && v !== null && (v as FgMatrix3D).__fgMat === 3;
}
