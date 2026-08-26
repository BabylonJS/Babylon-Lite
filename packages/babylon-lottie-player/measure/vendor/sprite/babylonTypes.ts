/**
 * Local, dependency-free equivalents of the handful of `@babylonjs/core` utility
 * types the ported Lottie code referenced (`core/types`, `core/Maths/math.like`).
 *
 * Keeping them local is what lets this package stay completely free of any
 * `@babylonjs/core` dependency while preserving the exact type contracts the
 * ported parsing / node / maths code was written against.
 */

/** A value of type `T` or `null` (≙ `core/types` `Nullable`). */
export type Nullable<T> = T | null;

/** A fixed-length tuple of `N` elements of type `T` (≙ `core/types` `Tuple`). */
export type Tuple<T, N extends number> = N extends N ? (number extends N ? T[] : _TupleOf<T, N, []>) : never;
type _TupleOf<T, N extends number, R extends unknown[]> = R["length"] extends N ? R : _TupleOf<T, N, [T, ...R]>;

/** Minimal 2D vector shape (≙ `core/Maths/math.like` `IVector2Like`). */
export interface IVector2Like {
    /** The x coordinate. */
    x: number;
    /** The y coordinate. */
    y: number;
}
