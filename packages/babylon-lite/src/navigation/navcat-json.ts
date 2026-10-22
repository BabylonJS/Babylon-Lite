import type { NavMesh } from "navcat";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numbers(value: unknown, multiple = 1): value is number[] {
    return Array.isArray(value) && value.length % multiple === 0 && value.every((n: unknown) => typeof n === "number" && Number.isFinite(n));
}

/** Validate the SDK asset's structural boundary, without converting its raw JSON schema. */
export function parseNavcatMesh(json: string): NavMesh {
    try {
        const mesh: unknown = JSON.parse(json);
        if (
            !record(mesh) ||
            !numbers(mesh.origin) ||
            mesh.origin.length !== 3 ||
            !(typeof mesh.tileWidth === "number" && Number.isFinite(mesh.tileWidth) && mesh.tileWidth > 0) ||
            !(typeof mesh.tileHeight === "number" && Number.isFinite(mesh.tileHeight) && mesh.tileHeight > 0)
        ) {
            throw new Error("origin or tile dimensions");
        }
        if (!Array.isArray(mesh.nodes) || !Array.isArray(mesh.links)) {
            throw new Error("nodes or links");
        }
        for (const key of ["tiles", "offMeshConnections", "offMeshConnectionAttachments", "tilePositionToTileId", "tileColumnToTileIds", "tilePositionToSequenceCounter"]) {
            if (!record(mesh[key])) {
                throw new Error(key);
            }
        }
        for (const key of ["nodeIndexPool", "tileIndexPool", "offMeshConnectionIndexPool", "linkIndexPool"]) {
            const pool = mesh[key];
            if (!record(pool) || !numbers(pool.free) || !Number.isInteger(pool.counter) || (pool.counter as number) < 0) {
                throw new Error(key);
            }
        }
        if (!Number.isInteger(mesh.offMeshConnectionSequenceCounter)) {
            throw new Error("connection sequence");
        }
        for (const tile of Object.values(mesh.tiles as Record<string, unknown>)) {
            if (
                !record(tile) ||
                !numbers(tile.vertices, 3) ||
                !numbers(tile.detailVertices, 3) ||
                !numbers(tile.detailTriangles, 4) ||
                !numbers(tile.polyNodes) ||
                !numbers(tile.bounds) ||
                tile.bounds.length !== 6 ||
                !Array.isArray(tile.polys) ||
                !Array.isArray(tile.detailMeshes) ||
                !record(tile.bvTree) ||
                !Array.isArray(tile.bvTree.nodes)
            ) {
                throw new Error("tile geometry");
            }
        }
        return mesh as unknown as NavMesh;
    } catch (error) {
        throw new Error("Invalid Navcat JSON", { cause: error });
    }
}
