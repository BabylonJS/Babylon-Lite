import type { Vec2 } from "./types.js";

/** Polar-coordinate value accepted by the pure polar helpers. */
export interface PolarCoordinates {
    radius: number;
    theta: number;
}

/** Component-wise operation supported by {@link combinePolarToRef}. */
export type PolarBinaryOperation = "add" | "subtract" | "multiply" | "divide";

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

/** Applies a component-wise operation to two polar-coordinate values. */
export function combinePolarToRef<T extends PolarCoordinates>(left: PolarCoordinates, right: PolarCoordinates, operation: PolarBinaryOperation, result: T): T {
    switch (operation) {
        case "add":
            result.radius = left.radius + right.radius;
            result.theta = left.theta + right.theta;
            break;
        case "subtract":
            result.radius = left.radius - right.radius;
            result.theta = left.theta - right.theta;
            break;
        case "multiply":
            result.radius = left.radius * right.radius;
            result.theta = left.theta * right.theta;
            break;
        case "divide":
            result.radius = left.radius / right.radius;
            result.theta = left.theta / right.theta;
            break;
    }
    return result;
}

/** Scales both components of a polar-coordinate value. */
export function scalePolarToRef<T extends PolarCoordinates>(polar: PolarCoordinates, scale: number, result: T): T {
    result.radius = polar.radius * scale;
    result.theta = polar.theta * scale;
    return result;
}
