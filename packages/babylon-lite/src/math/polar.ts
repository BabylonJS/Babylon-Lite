import type { Vec2 } from "./types.js";

/** Polar-coordinate value accepted by the pure polar helpers. */
export interface PolarCoordinates {
    radius: number;
    theta: number;
}

/** Writes the polar representation of `vector` into `result`. */
export function polarFromVec2ToRef<T extends PolarCoordinates>(vector: Vec2, result: T): T {
    result.radius = Math.hypot(vector.x, vector.y);
    result.theta = Math.atan2(vector.y, vector.x);
    return result;
}

/** Writes the rectangular representation of `polar` into `result`. */
export function polarToVec2ToRef<T extends Vec2>(polar: PolarCoordinates, result: T): T {
    result.x = polar.radius * Math.cos(polar.theta);
    result.y = polar.radius * Math.sin(polar.theta);
    return result;
}

/** Adds two polar-coordinate values component-wise. */
export function addPolarToRef<T extends PolarCoordinates>(left: PolarCoordinates, right: PolarCoordinates, result: T): T {
    result.radius = left.radius + right.radius;
    result.theta = left.theta + right.theta;
    return result;
}

/** Subtracts two polar-coordinate values component-wise. */
export function subtractPolarToRef<T extends PolarCoordinates>(left: PolarCoordinates, right: PolarCoordinates, result: T): T {
    result.radius = left.radius - right.radius;
    result.theta = left.theta - right.theta;
    return result;
}

/** Multiplies two polar-coordinate values component-wise. */
export function multiplyPolarToRef<T extends PolarCoordinates>(left: PolarCoordinates, right: PolarCoordinates, result: T): T {
    result.radius = left.radius * right.radius;
    result.theta = left.theta * right.theta;
    return result;
}

/** Divides two polar-coordinate values component-wise. */
export function dividePolarToRef<T extends PolarCoordinates>(left: PolarCoordinates, right: PolarCoordinates, result: T): T {
    result.radius = left.radius / right.radius;
    result.theta = left.theta / right.theta;
    return result;
}

/** Scales both components of a polar-coordinate value. */
export function scalePolarToRef<T extends PolarCoordinates>(polar: PolarCoordinates, scale: number, result: T): T {
    result.radius = polar.radius * scale;
    result.theta = polar.theta * scale;
    return result;
}
