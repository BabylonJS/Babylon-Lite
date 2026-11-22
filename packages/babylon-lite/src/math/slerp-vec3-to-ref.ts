import type { Vec3 } from "./types.js";

const EPSILON = 0.001;

/** Spherically interpolates vector direction and linearly interpolates magnitude. */
export function slerpVec3ToRef<T extends Vec3>(start: Vec3, end: Vec3, amount: number, result: T): T {
    const t = Math.min(1, Math.max(0, amount));
    const startLength = Math.sqrt(start.x * start.x + start.y * start.y + start.z * start.z);
    const endLength = Math.sqrt(end.x * end.x + end.y * end.y + end.z * end.z);
    const startX = startLength === 0 ? start.x : start.x / startLength;
    const startY = startLength === 0 ? start.y : start.y / startLength;
    const startZ = startLength === 0 ? start.z : start.z / startLength;
    let endX = endLength === 0 ? end.x : end.x / endLength;
    let endY = endLength === 0 ? end.y : end.y / endLength;
    let endZ = endLength === 0 ? end.z : end.z / endLength;
    const dot = startX * endX + startY * endY + startZ * endZ;
    let startScale: number;
    let endScale: number;

    if (dot <= -1 + EPSILON) {
        if (t >= 1) {
            result.x = end.x;
            result.y = end.y;
            result.z = end.z;
            return result;
        }

        let axisX = startY * endZ - startZ * endY;
        let axisY = startZ * endX - startX * endZ;
        let axisZ = startX * endY - startY * endX;
        const sinOmega = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
        const omega = Math.atan2(sinOmega, dot);
        if (sinOmega > 0) {
            axisX /= sinOmega;
            axisY /= sinOmega;
            axisZ /= sinOmega;
        } else if (Math.abs(startX) < 0.9) {
            axisX = 0;
            axisY = startZ;
            axisZ = -startY;
            const axisLength = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
            axisX /= axisLength;
            axisY /= axisLength;
            axisZ /= axisLength;
        } else {
            axisX = -startZ;
            axisY = 0;
            axisZ = startX;
            const axisLength = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
            axisX /= axisLength;
            axisY /= axisLength;
            axisZ /= axisLength;
        }

        endX = axisY * startZ - axisZ * startY;
        endY = axisZ * startX - axisX * startZ;
        endZ = axisX * startY - axisY * startX;
        const perpendicularLength = Math.sqrt(endX * endX + endY * endY + endZ * endZ);
        if (perpendicularLength !== 0 && perpendicularLength !== 1) {
            endX /= perpendicularLength;
            endY /= perpendicularLength;
            endZ /= perpendicularLength;
        }
        startScale = Math.cos(t * omega);
        endScale = Math.sin(t * omega);
    } else if (dot < 1 - EPSILON) {
        const omega = Math.acos(dot);
        const inverseSin = 1 / Math.sin(omega);
        startScale = Math.sin((1 - t) * omega) * inverseSin;
        endScale = Math.sin(t * omega) * inverseSin;
    } else {
        startScale = 1 - t;
        endScale = t;
    }

    const length = startLength + (endLength - startLength) * t;
    result.x = (startX * startScale + endX * endScale) * length;
    result.y = (startY * startScale + endY * endScale) * length;
    result.z = (startZ * startScale + endZ * endScale) * length;
    return result;
}
