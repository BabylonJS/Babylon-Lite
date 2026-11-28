import type { Vec3 } from "./types.js";
import { crossVec3 } from "./cross-vec3.js";
import { lengthVec3 } from "./length-vec3.js";
import { normalizeVec3 } from "./normalize-vec3.js";

function hermitePoint(p1: Vec3, t1: Vec3, p2: Vec3, t2: Vec3, amount: number): Vec3 {
    const amountSquared = amount * amount;
    const amountCubed = amountSquared * amount;
    const p1Weight = 2 * amountCubed - 3 * amountSquared + 1;
    const t1Weight = amountCubed - 2 * amountSquared + amount;
    const p2Weight = -2 * amountCubed + 3 * amountSquared;
    const t2Weight = amountCubed - amountSquared;
    return {
        x: p1Weight * p1.x + t1Weight * t1.x + p2Weight * p2.x + t2Weight * t2.x,
        y: p1Weight * p1.y + t1Weight * t1.y + p2Weight * p2.y + t2Weight * t2.y,
        z: p1Weight * p1.z + t1Weight * t1.z + p2Weight * p2.z + t2Weight * t2.z,
    };
}

function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, amount: number): Vec3 {
    const amountSquared = amount * amount;
    const amountCubed = amountSquared * amount;
    return {
        x: 0.5 * (2 * p1.x + (p2.x - p0.x) * amount + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * amountSquared + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * amountCubed),
        y: 0.5 * (2 * p1.y + (p2.y - p0.y) * amount + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * amountSquared + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * amountCubed),
        z: 0.5 * (2 * p1.z + (p2.z - p0.z) * amount + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * amountSquared + (3 * p1.z - p0.z - 3 * p2.z + p3.z) * amountCubed),
    };
}

/** Samples a cubic Hermite spline into `segmentCount + 1` points. */
export function sampleHermiteSpline(p1: Vec3, t1: Vec3, p2: Vec3, t2: Vec3, segmentCount: number): Vec3[] {
    const points: Vec3[] = [];
    const step = 1 / segmentCount;
    for (let index = 0; index <= segmentCount; index++) {
        points.push(hermitePoint(p1, t1, p2, t2, index * step));
    }
    return points;
}

/** Samples a Catmull-Rom spline, optionally wrapping its control points into a closed loop. */
export function sampleCatmullRomSpline(points: readonly Vec3[], pointsPerSegment: number, closed = false): Vec3[] {
    const sampled: Vec3[] = [];
    const step = 1 / pointsPerSegment;

    if (closed) {
        for (let index = 0; index < points.length; index++) {
            for (let sample = 0; sample < pointsPerSegment; sample++) {
                sampled.push(
                    catmullRomPoint(
                        points[index % points.length]!,
                        points[(index + 1) % points.length]!,
                        points[(index + 2) % points.length]!,
                        points[(index + 3) % points.length]!,
                        sample * step
                    )
                );
            }
        }
        sampled.push({ ...sampled[0]! });
        return sampled;
    }

    const controls = [points[0]!, ...points, points[points.length - 1]!];
    let index = 0;
    for (; index < controls.length - 3; index++) {
        for (let sample = 0; sample < pointsPerSegment; sample++) {
            sampled.push(catmullRomPoint(controls[index]!, controls[index + 1]!, controls[index + 2]!, controls[index + 3]!, sample * step));
        }
    }
    index--;
    sampled.push(catmullRomPoint(controls[index]!, controls[index + 1]!, controls[index + 2]!, controls[index + 3]!, 1));
    return sampled;
}

/** Samples the circular arc passing through three points with Babylon.js `Curve3.ArcThru3Points` semantics. */
export function sampleArcThroughThreePoints(first: Vec3, second: Vec3, third: Vec3, steps = 32, closed = false, fullCircle = false): Vec3[] {
    const arc: Vec3[] = [];
    const vec1 = subtract(second, first);
    const vec2 = subtract(third, second);
    const vec3 = subtract(first, third);
    const zAxis = crossVec3(vec1, vec2);
    const crossLength = lengthVec3(zAxis);
    if (crossLength < 1e-8) {
        return arc;
    }

    const len1Squared = dot(vec1, vec1);
    const len2Squared = dot(vec2, vec2);
    const len3Squared = dot(vec3, vec3);
    const crossLengthSquared = dot(zAxis, zAxis);
    const radius = (0.5 * Math.sqrt(len1Squared) * Math.sqrt(len2Squared) * Math.sqrt(len3Squared)) / crossLength;
    const a = (-0.5 * len2Squared * dot(vec1, vec3)) / crossLengthSquared;
    const b = (-0.5 * len3Squared * dot(vec1, vec2)) / crossLengthSquared;
    const c = (-0.5 * len1Squared * dot(vec2, vec3)) / crossLengthSquared;
    const center = {
        x: first.x * a + second.x * b + third.x * c,
        y: first.y * a + second.y * b + third.y * c,
        z: first.z * a + second.z * b + third.z * c,
    };
    const xAxis = normalizeVec3(subtract(first, center));
    const yAxis = normalizeVec3(crossVec3(zAxis, xAxis));

    if (fullCircle) {
        arc.push({ ...first });
        if (steps > 0) {
            const step = (2 * Math.PI) / steps;
            for (let index = 1; index < steps; index++) {
                arc.push(pointOnCircle(center, xAxis, yAxis, radius, index * step));
            }
            arc.push({ ...first });
        }
        return arc;
    }

    const step = 1 / steps;
    let theta = 0;
    let point: Vec3;
    do {
        point = pointOnCircle(center, xAxis, yAxis, radius, theta);
        arc.push(point);
        theta += step;
    } while (!equalsWithEpsilon(point, third, radius * step * 1.1));
    arc.push(third);
    if (closed) {
        arc.push(first);
    }
    return arc;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function pointOnCircle(center: Vec3, xAxis: Vec3, yAxis: Vec3, radius: number, theta: number): Vec3 {
    const xScale = radius * Math.cos(theta);
    const yScale = radius * Math.sin(theta);
    return {
        x: center.x + xAxis.x * xScale + yAxis.x * yScale,
        y: center.y + xAxis.y * xScale + yAxis.y * yScale,
        z: center.z + xAxis.z * xScale + yAxis.z * yScale,
    };
}

function equalsWithEpsilon(a: Vec3, b: Vec3, epsilon: number): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon && Math.abs(a.z - b.z) <= epsilon;
}
