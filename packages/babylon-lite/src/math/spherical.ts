import type { Vec3 } from "./types.js";

/** Spherical-coordinate value accepted by the pure spherical helpers. */
export interface SphericalCoordinates {
    radius: number;
    theta: number;
    phi: number;
}

/** Writes the spherical representation of `vector` into `result`. */
export function sphericalFromVec3ToRef<T extends SphericalCoordinates>(vector: Vec3, result: T): T {
    result.radius = Math.hypot(vector.x, vector.y, vector.z);
    result.theta = Math.acos(vector.y / result.radius);
    result.phi = Math.atan2(vector.z, vector.x);
    return result;
}

/** Writes the rectangular representation of `spherical` into `result`. */
export function sphericalToVec3ToRef<T extends Vec3>(spherical: SphericalCoordinates, result: T): T {
    const sinTheta = Math.sin(spherical.theta);
    result.x = spherical.radius * sinTheta * Math.cos(spherical.phi);
    result.y = spherical.radius * Math.cos(spherical.theta);
    result.z = spherical.radius * sinTheta * Math.sin(spherical.phi);
    return result;
}

/** Adds two spherical-coordinate values component-wise. */
export function addSphericalToRef<T extends SphericalCoordinates>(left: SphericalCoordinates, right: SphericalCoordinates, result: T): T {
    result.radius = left.radius + right.radius;
    result.theta = left.theta + right.theta;
    result.phi = left.phi + right.phi;
    return result;
}

/** Subtracts two spherical-coordinate values component-wise. */
export function subtractSphericalToRef<T extends SphericalCoordinates>(left: SphericalCoordinates, right: SphericalCoordinates, result: T): T {
    result.radius = left.radius - right.radius;
    result.theta = left.theta - right.theta;
    result.phi = left.phi - right.phi;
    return result;
}

/** Multiplies two spherical-coordinate values component-wise. */
export function multiplySphericalToRef<T extends SphericalCoordinates>(left: SphericalCoordinates, right: SphericalCoordinates, result: T): T {
    result.radius = left.radius * right.radius;
    result.theta = left.theta * right.theta;
    result.phi = left.phi * right.phi;
    return result;
}

/** Divides two spherical-coordinate values component-wise. */
export function divideSphericalToRef<T extends SphericalCoordinates>(left: SphericalCoordinates, right: SphericalCoordinates, result: T): T {
    result.radius = left.radius / right.radius;
    result.theta = left.theta / right.theta;
    result.phi = left.phi / right.phi;
    return result;
}

/** Scales every component of a spherical-coordinate value. */
export function scaleSphericalToRef<T extends SphericalCoordinates>(spherical: SphericalCoordinates, scale: number, result: T): T {
    result.radius = spherical.radius * scale;
    result.theta = spherical.theta * scale;
    result.phi = spherical.phi * scale;
    return result;
}
