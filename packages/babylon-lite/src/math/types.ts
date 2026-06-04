// Core math types — plain typed objects, not classes.
// Pure functions operate on these. Data-oriented for GPU buffer packing.

/** 3-component vector (position, direction, color) */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** 3-component vector as a fixed-length `[x, y, z]` tuple. */
export type Vec3Tuple = [number, number, number];

/** 4-component vector (homogeneous coords, quaternion, tangent) */
export interface Vec4 {
    x: number;
    y: number;
    z: number;
    w: number;
}

/** RGB color */
export interface Color3 {
    r: number;
    g: number;
    b: number;
}

/** RGBA color */
export interface Color4 {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** 4x4 column-major matrix (16 elements).
 *  Layout matches WebGPU/WGSL mat4x4<f32> memory order. Opaque-by-convention:
 *  callers MUST NOT depend on the underlying storage (Float32Array vs
 *  Float64Array). Internal kernels and uploaders use the `Mat4Storage` view
 *  defined below to access the concrete typed array behind the brand. */
export interface Mat4 {
    /** @internal */
    readonly __brand: "Mat4";
    readonly length: 16;
    readonly [index: number]: number;
}

/** Quaternion rotation */
export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}

/** @internal Storage view used by kernels, allocators, and the upload packer.
 *  Raw typed-array union (no brand) so callers can pass `new Float32Array(16)`
 *  directly to kernels without laundering through the `Mat4` brand. The brand
 *  on `Mat4` exists to prevent users from spoofing matrices into the engine;
 *  internal kernels operate on `Mat4Storage` precisely because they don't
 *  need the brand check. Not re-exported from `index.ts`. */
export type Mat4Storage = Float32Array | Float64Array;
