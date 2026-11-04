import type { EngineContext } from "../engine/engine.js";
import type { Color4, Vec3 } from "../math/types.js";
import type { LineMaterial } from "../material/line/line-material.js";
import { createLineSystem, updateLineSystem } from "./create-line-system.js";
import type { Mesh } from "./mesh.js";

export interface DashedLinesOptions {
    readonly name?: string;
    readonly points: ReadonlyArray<Vec3>;
    readonly dashSize?: number;
    readonly gapSize?: number;
    readonly dashNb?: number;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly material?: LineMaterial;
}

export interface DashedLinesUpdateOptions {
    readonly points: ReadonlyArray<Vec3>;
}

function buildDashedLineSegments(points: ReadonlyArray<Vec3>, dashSize: number, gapSize: number, stepCount: number, fixedSegmentCount?: number): Vec3[][] {
    if (points.length < 2) {
        throw new Error("Dashed lines require at least two points");
    }

    let lengthDiag = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        lengthDiag += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }

    const shft = lengthDiag / stepCount;
    const dashshft = (dashSize * shft) / (dashSize + gapSize);
    const segments: Vec3[][] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        let vx = b.x - a.x;
        let vy = b.y - a.y;
        let vz = b.z - a.z;
        const len = Math.hypot(vx, vy, vz);
        const nb = len > 0 ? Math.floor(len / shft) : 0;
        if (len > 0) {
            vx /= len;
            vy /= len;
            vz /= len;
        }
        for (let j = 0; j < nb && (fixedSegmentCount === undefined || segments.length < fixedSegmentCount); j++) {
            const curshft = shft * j;
            segments.push([
                { x: a.x + curshft * vx, y: a.y + curshft * vy, z: a.z + curshft * vz },
                { x: a.x + (curshft + dashshft) * vx, y: a.y + (curshft + dashshft) * vy, z: a.z + (curshft + dashshft) * vz },
            ]);
        }
    }

    if (fixedSegmentCount !== undefined) {
        const last = points[points.length - 1]!;
        while (segments.length < fixedSegmentCount) {
            segments.push([
                { x: last.x, y: last.y, z: last.z },
                { x: last.x, y: last.y, z: last.z },
            ]);
        }
    }
    return segments;
}

/**
 * Build a dashed polyline as an indexed line-list of independent dash segments.
 *
 * The dash spacing mirrors the classic builder algorithm: the total polyline
 * length is divided into `dashNb` steps of length `shft`; each step holds one
 * visible dash of length `dashSize / (dashSize + gapSize) * shft` followed by a
 * gap. Each dash is emitted as a standalone two-point segment through the
 * existing line-system primitive, so the result is an ordinary line-list mesh.
 */
export function createDashedLines(engine: EngineContext, options: DashedLinesOptions): Mesh {
    const dashSize = options.dashSize ?? 3;
    const gapSize = options.gapSize ?? 1;
    const dashNb = options.dashNb ?? 200;
    const segments = buildDashedLineSegments(options.points, dashSize, gapSize, dashNb);

    if (segments.length === 0) {
        throw new Error("createDashedLines produced no dash segments (degenerate points or dashNb)");
    }

    const mesh = createLineSystem(engine, {
        name: options.name ?? "dashedLines",
        lines: segments,
        color: options.color,
        useVertexAlpha: options.useVertexAlpha,
        material: options.material,
    });
    mesh._dashedLineOptions = [dashSize, gapSize];
    return mesh;
}

/** Update dashed-line positions while preserving the mesh's existing dash topology. */
export function updateDashedLines(engine: EngineContext, mesh: Mesh, options: DashedLinesUpdateOptions): void {
    const dashOptions = mesh._dashedLineOptions;
    const segmentCount = mesh._linePointCounts?.length;
    if (!dashOptions || !segmentCount) {
        throw new Error("updateDashedLines requires a mesh created by createDashedLines");
    }
    const segments = buildDashedLineSegments(options.points, dashOptions[0], dashOptions[1], segmentCount, segmentCount);
    updateLineSystem(engine, mesh, { lines: segments });
}
