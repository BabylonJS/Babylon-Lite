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

/** 4x4 column-major matrix stored as a flat Float32Array (16 elements).
 *  Layout matches WebGPU/WGSL mat4x4<f32> memory order. */
export type Mat4 = Float32Array & { readonly __brand: "Mat4" };

/** Quaternion rotation */
export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}
