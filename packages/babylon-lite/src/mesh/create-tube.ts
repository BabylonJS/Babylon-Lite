/**
 * CreateTube — matches Babylon.js MeshBuilder.CreateTube defaults.
 *
 * Generates a tube (cylinder following an arbitrary path) by building a
 * closed ribbon whose paths are circles placed at each curve point, oriented
 * by the Frenet frame computed by `computePath3D`.
 *
 * Options omitted vs. BJS: `updatable`, `sideOrientation`, `frontUVs/backUVs`,
 * `invertUV`, `instance`. Defaults match: radius 1, tessellation 64,
 * cap NO_CAP, arc 1.
 */

import type { Vec3 } from "../math/types.js";
import { computePath3D } from "./path3d.js";
import { createRibbonData, type RibbonData } from "./create-ribbon.js";

/** Cap mode: no caps on either end of the tube/extrusion. */
export const CAP_NONE = 0;
/** Cap mode: close only the start of the tube/extrusion. */
export const CAP_START = 1;
/** Cap mode: close only the end of the tube/extrusion. */
export const CAP_END = 2;
/** Cap mode: close both ends of the tube/extrusion. */
export const CAP_ALL = 3;

/** Options for `createTubeData`: a circular cross-section swept along a path. */
export interface TubeOptions {
    path: Vec3[];
    radius?: number;
    tessellation?: number;
    /** Per-point radius override; receives the point index and its distance along the path. */
    radiusFunction?: (i: number, distance: number) => number;
    cap?: number;
    arc?: number;
}

function rodrigues(v: Vec3, k: Vec3, angle: number): Vec3 {
    // v is a unit/scaled vector, k is a unit axis.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dot = k.x * v.x + k.y * v.y + k.z * v.z;
    const crossX = k.y * v.z - k.z * v.y;
    const crossY = k.z * v.x - k.x * v.z;
    const crossZ = k.x * v.y - k.y * v.x;
    return {
        x: v.x * c + crossX * s + k.x * dot * (1 - c),
        y: v.y * c + crossY * s + k.y * dot * (1 - c),
        z: v.z * c + crossZ * s + k.z * dot * (1 - c),
    };
}

export function createTubeData(options: TubeOptions): RibbonData {
    const path = options.path;
    const radius = options.radius ?? 1;
    const tessellation = (options.tessellation ?? 64) | 0;
    const radiusFunction = options.radiusFunction ?? null;
    let cap = options.cap ?? CAP_NONE;
    cap = cap < 0 || cap > 3 ? CAP_NONE : cap;
    const arc = options.arc && (options.arc <= 0 || options.arc > 1) ? 1 : (options.arc ?? 1);

    const path3D = computePath3D(path);
    const { tangents, normals, distances } = path3D;

    const pi2 = Math.PI * 2;
    const step = (pi2 / tessellation) * arc;
    const circlePaths: Vec3[][] = [];
    let index = cap === CAP_NONE || cap === CAP_END ? 0 : 2;

    for (let i = 0; i < path.length; i++) {
        const rad = radiusFunction ? radiusFunction(i, distances[i]!) : radius;
        const circle: Vec3[] = [];
        const normal = normals[i]!;
        const tangent = tangents[i]!;
        for (let t = 0; t < tessellation; t++) {
            const rotated = rodrigues(normal, tangent, step * t);
            circle.push({
                x: rotated.x * rad + path[i]!.x,
                y: rotated.y * rad + path[i]!.y,
                z: rotated.z * rad + path[i]!.z,
            });
        }
        circlePaths[index] = circle;
        index++;
    }

    const capPath = (nbPoints: number, pathIndex: number): Vec3[] => {
        const pts: Vec3[] = [];
        for (let i = 0; i < nbPoints; i++) {
            pts.push(path[pathIndex]!);
        }
        return pts;
    };
    if (cap === CAP_START || cap === CAP_ALL) {
        circlePaths[0] = capPath(tessellation, 0);
        circlePaths[1] = circlePaths[2]!.slice(0);
    }
    if (cap === CAP_END || cap === CAP_ALL) {
        circlePaths[index] = circlePaths[index - 1]!.slice(0);
        circlePaths[index + 1] = capPath(tessellation, path.length - 1);
    }

    return createRibbonData({
        pathArray: circlePaths,
        closePath: true,
        closeArray: false,
    });
}
