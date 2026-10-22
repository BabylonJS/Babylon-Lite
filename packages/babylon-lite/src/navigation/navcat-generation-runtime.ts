import { generateSoloNavMesh } from "navcat/blocks";
import type { NavcatBuildOptions, NavcatGeometry } from "./navcat-types.js";

export function generate(geometry: NavcatGeometry, o: Required<NavcatBuildOptions>): string {
    const result = generateSoloNavMesh(geometry, {
        cellSize: o.cellSize,
        cellHeight: o.cellHeight,
        walkableRadiusVoxels: Math.ceil(o.agentRadius / o.cellSize),
        walkableRadiusWorld: o.agentRadius,
        walkableClimbVoxels: Math.floor(o.maxClimb / o.cellHeight),
        walkableClimbWorld: o.maxClimb,
        walkableHeightVoxels: Math.ceil(o.agentHeight / o.cellHeight),
        walkableHeightWorld: o.agentHeight,
        walkableSlopeAngleDegrees: o.maxSlope,
        borderSize: 0,
        minRegionArea: o.minRegionArea,
        mergeRegionArea: o.mergeRegionArea,
        maxSimplificationError: o.maxSimplificationError,
        maxEdgeLength: o.maxEdgeLength,
        maxVerticesPerPoly: o.maxVerticesPerPoly,
        detailSampleDistance: o.detailSampleDistance,
        detailSampleMaxError: o.detailSampleMaxError,
    });
    return JSON.stringify(result.navMesh);
}
