import type { NavcatBuildOptions, NavcatGeometry } from "./navcat-types.js";

/** Generate a versioned RH Navcat JSON asset. Intended for offline tooling; never loaded by query-only use. */
export async function generateNavcatMesh(geometry: NavcatGeometry, options: NavcatBuildOptions = {}): Promise<string> {
    if (geometry.positions.length === 0 || geometry.positions.length % 3 !== 0 || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) {
        throw new Error("Navcat generation requires indexed triangles");
    }
    const positions = new Float64Array(geometry.positions);
    const indices = new Uint32Array(geometry.indices);
    if (!positions.every(Number.isFinite)) {
        throw new Error("Navcat generation has nonfinite positions or invalid indices");
    }
    for (let i = 0; i < geometry.indices.length; i++) {
        const index = geometry.indices[i]!;
        if (!Number.isInteger(index) || index < 0 || index >= positions.length / 3) {
            throw new Error("Navcat generation has nonfinite positions or invalid indices");
        }
    }
    const settings: Required<NavcatBuildOptions> = {
        cellSize: options.cellSize ?? 0.15,
        cellHeight: options.cellHeight ?? 0.1,
        agentRadius: options.agentRadius ?? 0.3,
        agentHeight: options.agentHeight ?? 1.8,
        maxClimb: options.maxClimb ?? 0.4,
        maxSlope: options.maxSlope ?? 45,
        minRegionArea: options.minRegionArea ?? 1,
        mergeRegionArea: options.mergeRegionArea ?? 20,
        maxSimplificationError: options.maxSimplificationError ?? 1.3,
        maxEdgeLength: options.maxEdgeLength ?? 12,
        maxVerticesPerPoly: options.maxVerticesPerPoly ?? 6,
        detailSampleDistance: options.detailSampleDistance ?? 0.9,
        detailSampleMaxError: options.detailSampleMaxError ?? 0.1,
    };
    for (const [key, value] of Object.entries(settings)) {
        if (!Number.isFinite(value) || value < 0 || (["cellSize", "cellHeight", "agentHeight"].includes(key) && value === 0)) {
            throw new Error(`Invalid Navcat build option: ${key}`);
        }
    }
    if (settings.maxSlope > 90 || !Number.isInteger(settings.maxVerticesPerPoly) || settings.maxVerticesPerPoly < 3 || settings.maxVerticesPerPoly > 6) {
        throw new Error("Invalid Navcat slope or polygon vertex limit");
    }
    return (await import("./navcat-generation-runtime.js")).generate({ positions, indices }, settings);
}
