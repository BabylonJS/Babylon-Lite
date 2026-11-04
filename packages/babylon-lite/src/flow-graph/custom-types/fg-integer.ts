// glTF `int` is distinct from `float`. Represented as a tagged plain object
// (no class) so type coercion and bitwise ops can detect and operate on it.
// Pure helpers only; zero module-level allocation.

/** A tagged 32-bit integer value. glTF `int` maps to this. */
export interface FgInteger {
    readonly value: number;
    /** @internal Discriminant tag. */
    readonly __fgInt: true;
}

/** Construct an `FgInteger`, normalizing to a 32-bit signed integer. */
export function fgInt(n: number): FgInteger {
    return { value: n | 0, __fgInt: true };
}

/** Type guard for `FgInteger`. */
export function isFgInt(v: unknown): v is FgInteger {
    return typeof v === "object" && v !== null && (v as FgInteger).__fgInt === true;
}
