/**
 * CreateExtrudeShape — matches Babylon.js MeshBuilder.ExtrudeShape defaults.
 *
 * Sweeps a 2D `shape` (an array of Vec3 designed in the xOy plane; z becomes
 * the "along-tangent" dimension) along a 3D `path`, scaling and rotating at
 * each path point. Under the hood it builds a ribbon whose rows are the
 * transformed shape at each path position.
 *
 * Options omitted vs. BJS: `updatable`, `sideOrientation`, `frontUVs/backUVs`,
 * `invertUV`, `instance`, `closeShape`, `closePath`, `firstNormal`,
 * `adjustFrame`, `capFunction`. Defaults match: scale 1, rotation 0,
 * cap NO_CAP.
 */

import type { Vec3 } from "../math/types.js";
import { computePath3D } from "./path3d.js";
import { createRibbonData, type RibbonData } from "./create-ribbon.js";
import { CAP_NONE, CAP_START, CAP_END, CAP_ALL } from "./create-tube.js";
export { CAP_NONE, CAP_START, CAP_END, CAP_ALL } from "./create-tube.js";

/** Options for `createExtrudeShapeData`: a 2D `shape` swept along a 3D `path`. */
export interface ExtrudeShapeOptions {
    shape: Vec3[];
    path: Vec3[];
    scale?: number;
    rotation?: number;
    cap?: number;
}

function rodrigues(v: Vec3, k: Vec3, angle: number): Vec3 {
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

export function createExtrudeShapeData(options: ExtrudeShapeOptions): RibbonData {
    const shape = options.shape;
    const curve = options.path;
    const scale = options.scale ?? 1;
    const rotation = options.rotation ?? 0;
    let cap = options.cap ?? CAP_NONE;
    cap = cap < 0 || cap > 3 ? CAP_NONE : cap;

    const path3D = computePath3D(curve);
    const { tangents, normals, binormals } = path3D;

    const shapePaths: Vec3[][] = [];
    let index = cap === CAP_NONE || cap === CAP_END ? 0 : 2;
    let angle = 0;
    for (let i = 0; i < curve.length; i++) {
        const shapePath: Vec3[] = [];
        const t = tangents[i]!;
        const n = normals[i]!;
        const b = binormals[i]!;
        for (let p = 0; p < shape.length; p++) {
            const sp = shape[p]!;
            // planed = t*sp.z + n*sp.x + b*sp.y
            const planed = {
                x: t.x * sp.z + n.x * sp.x + b.x * sp.y,
                y: t.y * sp.z + n.y * sp.x + b.y * sp.y,
                z: t.z * sp.z + n.z * sp.x + b.z * sp.y,
            };
            const rotated = rodrigues(planed, t, angle);
            shapePath.push({
                x: rotated.x * scale + curve[i]!.x,
                y: rotated.y * scale + curve[i]!.y,
                z: rotated.z * scale + curve[i]!.z,
            });
        }
        shapePaths[index] = shapePath;
        angle += rotation;
        index++;
    }

    const barycenterCap = (shapePath: Vec3[]): Vec3[] => {
        const bc = { x: 0, y: 0, z: 0 };
        for (const pt of shapePath) {
            bc.x += pt.x;
            bc.y += pt.y;
            bc.z += pt.z;
        }
        const inv = 1 / shapePath.length;
        bc.x *= inv;
        bc.y *= inv;
        bc.z *= inv;
        const out: Vec3[] = [];
        for (let i = 0; i < shapePath.length; i++) {
            out.push(bc);
        }
        return out;
    };

    if (cap === CAP_START || cap === CAP_ALL) {
        shapePaths[0] = barycenterCap(shapePaths[2]!);
        shapePaths[1] = shapePaths[2]!;
    }
    if (cap === CAP_END || cap === CAP_ALL) {
        shapePaths[index] = shapePaths[index - 1]!;
        shapePaths[index + 1] = barycenterCap(shapePaths[index - 1]!);
    }

    return createRibbonData({
        pathArray: shapePaths,
        closeArray: false,
        closePath: false,
    });
}
