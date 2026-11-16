import type { NavMesh } from "navcat";

const FORMAT = "babylon-lite-navcat";
const SDK_VERSION = "0.4.1";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
    return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function numbers(value: unknown, multiple = 1): value is number[] {
    return Array.isArray(value) && value.length % multiple === 0 && value.every(finite);
}

function integers(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number[] {
    return Array.isArray(value) && value.every((n: unknown) => integer(n, 0, max));
}

function valid(condition: unknown, field: string): asserts condition {
    if (!condition) {
        throw new Error(field);
    }
}

function bounds(value: unknown): boolean {
    return numbers(value) && value.length === 6 && value[0]! <= value[3]! && value[1]! <= value[4]! && value[2]! <= value[5]!;
}

function vector(value: unknown): boolean {
    return numbers(value) && value.length === 3;
}

function flagsArea(value: Record<string, unknown>): boolean {
    return integer(value.flags, 0, 0xffff) && integer(value.area);
}

/** Serialize an owned SDK mesh with the exact adapter/SDK versions required to reload it. */
export function stringifyNavcatMesh(mesh: NavMesh): string {
    return JSON.stringify({ format: FORMAT, formatVersion: 1, sdkVersion: SDK_VERSION, navMesh: mesh });
}

/** Validate the pinned SDK's nested query boundary before publishing an owned mesh. */
export function parseNavcatMesh(json: string): NavMesh {
    try {
        const asset: unknown = JSON.parse(json);
        valid(record(asset), "asset envelope");
        valid(asset.format === FORMAT, "unsupported format (expected babylon-lite-navcat envelope)");
        valid(asset.formatVersion === 1, "unsupported format version");
        valid(asset.sdkVersion === SDK_VERSION, "unsupported SDK version (expected 0.4.1)");
        const mesh = asset.navMesh;
        valid(record(mesh), "navMesh");
        valid(vector(mesh.origin) && finite(mesh.tileWidth) && mesh.tileWidth > 0 && finite(mesh.tileHeight) && mesh.tileHeight > 0, "origin or tile dimensions");
        valid(Array.isArray(mesh.nodes) && Array.isArray(mesh.links), "nodes or links");
        for (const key of ["tiles", "offMeshConnections", "offMeshConnectionAttachments", "tilePositionToTileId", "tileColumnToTileIds", "tilePositionToSequenceCounter"]) {
            valid(record(mesh[key]), key);
        }
        for (const key of ["nodeIndexPool", "tileIndexPool", "offMeshConnectionIndexPool", "linkIndexPool"]) {
            const pool = mesh[key];
            valid(record(pool) && integer(pool.counter) && integers(pool.free, pool.counter - 1), key);
        }
        valid(integer(mesh.offMeshConnectionSequenceCounter), "connection sequence");
        const typed = mesh as unknown as NavMesh;
        for (const [id, value] of Object.entries(mesh.tiles as Record<string, unknown>)) {
            valid(record(value), "tile");
            valid(
                integer(value.id) &&
                    String(value.id) === id &&
                    integer(value.sequence, 0, 0xfffff) &&
                    integer(value.tileX, -Number.MAX_SAFE_INTEGER) &&
                    integer(value.tileY, -Number.MAX_SAFE_INTEGER) &&
                    integer(value.tileLayer),
                "tile identity"
            );
            valid(numbers(value.vertices, 3) && numbers(value.detailVertices, 3) && integers(value.detailTriangles) && value.detailTriangles.length % 4 === 0, "tile coordinates");
            valid(
                bounds(value.bounds) &&
                    Array.isArray(value.polys) &&
                    Array.isArray(value.detailMeshes) &&
                    value.detailMeshes.length === value.polys.length &&
                    integers(value.polyNodes, mesh.nodes.length - 1) &&
                    value.polyNodes.length === value.polys.length,
                "tile polygons"
            );
            for (const key of ["cellSize", "cellHeight", "walkableHeight", "walkableRadius", "walkableClimb"]) {
                valid(finite(value[key]) && (value[key] as number) >= 0 && ((key !== "cellSize" && key !== "cellHeight") || (value[key] as number) > 0), `tile ${key}`);
            }
            const polygonCount = value.polys.length;
            for (let i = 0; i < polygonCount; i++) {
                const poly: unknown = value.polys[i];
                const detail: unknown = value.detailMeshes[i];
                valid(
                    record(poly) &&
                        integers(poly.vertices, value.vertices.length / 3 - 1) &&
                        poly.vertices.length >= 3 &&
                        integers(poly.neis, 0xffff) &&
                        poly.neis.every((neighbor) => (neighbor & 0x8000) !== 0 || neighbor <= polygonCount) &&
                        poly.neis.length === poly.vertices.length &&
                        flagsArea(poly),
                    "polygon vertices, neighbors or flags"
                );
                valid(
                    record(detail) && integer(detail.verticesBase) && integer(detail.verticesCount) && integer(detail.trianglesBase) && integer(detail.trianglesCount),
                    "detail mesh"
                );
                valid(
                    detail.verticesBase + detail.verticesCount <= value.detailVertices.length / 3 &&
                        detail.trianglesBase + detail.trianglesCount <= value.detailTriangles.length / 4,
                    "detail mesh range"
                );
                for (let t = detail.trianglesBase; t < detail.trianglesBase + detail.trianglesCount; t++) {
                    const vertexCount = poly.vertices.length + detail.verticesCount;
                    valid(
                        value.detailTriangles[t * 4]! < vertexCount && value.detailTriangles[t * 4 + 1]! < vertexCount && value.detailTriangles[t * 4 + 2]! < vertexCount,
                        "detail triangle index"
                    );
                }
            }
            valid(record(value.bvTree) && finite(value.bvTree.quantFactor) && value.bvTree.quantFactor > 0 && Array.isArray(value.bvTree.nodes), "BV tree");
            for (let i = 0; i < value.bvTree.nodes.length; i++) {
                const node: unknown = value.bvTree.nodes[i];
                valid(
                    record(node) &&
                        bounds(node.bounds) &&
                        integer(node.i, -Number.MAX_SAFE_INTEGER) &&
                        (node.i >= 0 ? node.i < value.polys.length : i - node.i <= value.bvTree.nodes.length),
                    "BV tree node"
                );
            }
        }
        for (let i = 0; i < mesh.nodes.length; i++) {
            const node: unknown = mesh.nodes[i];
            valid(
                record(node) &&
                    typeof node.allocated === "boolean" &&
                    node.index === i &&
                    integer(node.ref) &&
                    (node.type === 0 || node.type === 1) &&
                    (!node.allocated || flagsArea(node)) &&
                    integers(node.links, mesh.links.length - 1),
                "node metadata"
            );
            if (!node.allocated) {
                continue;
            }
            if (node.type === 0) {
                valid(integer(node.tileId) && integer(node.polyIndex), "polygon node identity");
                const tile = typed.tiles[node.tileId];
                valid(tile && node.polyIndex < tile.polys.length && tile.polyNodes[node.polyIndex] === i, "polygon node reference");
                valid(node.ref === tile.sequence * 0x100000000 + i * 2, "packed polygon node reference");
            } else {
                valid(integer(node.offMeshConnectionId) && typed.offMeshConnections[node.offMeshConnectionId], "connection node reference");
                valid(node.ref === typed.offMeshConnections[node.offMeshConnectionId]!.sequence * 0x100000000 + i * 2 + 1, "packed connection node reference");
            }
            for (const link of node.links) {
                valid(typed.links[link]?.allocated && typed.links[link]!.fromNodeIndex === i, "node link reference");
            }
        }
        for (let i = 0; i < mesh.links.length; i++) {
            const link: unknown = mesh.links[i];
            valid(record(link) && typeof link.allocated === "boolean" && link.index === i, "link metadata");
            if (!link.allocated) {
                continue;
            }
            valid(integer(link.fromNodeIndex, 0, mesh.nodes.length - 1) && integer(link.toNodeIndex, 0, mesh.nodes.length - 1), "link node index");
            const from = typed.nodes[link.fromNodeIndex]!;
            const to = typed.nodes[link.toNodeIndex]!;
            const maxEdge = from.type === 1 || to.type === 1 ? 1 : typed.tiles[from.tileId]!.polys[from.polyIndex]!.vertices.length - 1;
            valid(integer(link.edge, 0, maxEdge) && from.links.includes(i), "link edge or ownership");
            valid(
                from.allocated &&
                    to.allocated &&
                    from.ref === link.fromNodeRef &&
                    to.ref === link.toNodeRef &&
                    integer(link.edge, -1) &&
                    integer(link.side) &&
                    finite(link.bmin) &&
                    finite(link.bmax),
                "link node reference"
            );
        }
        for (const [id, connection] of Object.entries(mesh.offMeshConnections as Record<string, unknown>)) {
            valid(
                record(connection) &&
                    integer(connection.id) &&
                    String(connection.id) === id &&
                    integer(connection.sequence, 0, 0xfffff) &&
                    vector(connection.start) &&
                    vector(connection.end) &&
                    finite(connection.radius) &&
                    connection.radius >= 0 &&
                    (connection.direction === 0 || connection.direction === 1) &&
                    flagsArea(connection),
                "connection definition"
            );
        }
        for (const [id, attachment] of Object.entries(mesh.offMeshConnectionAttachments as Record<string, unknown>)) {
            valid(typed.offMeshConnections[id] && record(attachment), "connection attachment");
            for (const key of ["offMeshNode", "startPolyNode", "endPolyNode"]) {
                valid(
                    integer(attachment[key], -1) && (attachment[key] === -1 || typed.nodes.some((node) => node.allocated && node.ref === attachment[key])),
                    "connection attachment node"
                );
            }
        }
        for (const id of Object.values(mesh.tilePositionToTileId as Record<string, unknown>)) {
            valid(integer(id) && typed.tiles[id], "tile position mapping");
        }
        for (const ids of Object.values(mesh.tileColumnToTileIds as Record<string, unknown>)) {
            valid(integers(ids) && ids.every((id) => typed.tiles[id]), "tile column mapping");
        }
        for (const sequence of Object.values(mesh.tilePositionToSequenceCounter as Record<string, unknown>)) {
            valid(integer(sequence), "tile position sequence");
        }
        for (const [pool, items] of [
            [typed.nodeIndexPool, typed.nodes],
            [typed.linkIndexPool, typed.links],
        ] as const) {
            const free = new Set(pool.free);
            valid(pool.counter === items.length && free.size === pool.free.length, "node/link pool counter or duplicate free index");
            for (let i = 0; i < items.length; i++) {
                valid(free.has(i) === !items[i]!.allocated, "node/link pool free allocation");
            }
        }
        for (const [pool, entries] of [
            [typed.tileIndexPool, typed.tiles],
            [typed.offMeshConnectionIndexPool, typed.offMeshConnections],
        ] as const) {
            const free = new Set(pool.free);
            valid(pool.counter === Object.keys(entries).length + free.size && free.size === pool.free.length, "tile/connection pool counter or duplicate free index");
            for (const id of Object.keys(entries)) {
                valid(integer(Number(id), 0, pool.counter - 1) && !free.has(Number(id)), "tile/connection pool free allocation");
            }
        }
        return typed;
    } catch (error) {
        throw new Error(`Invalid Navcat JSON: ${error instanceof Error ? error.message : "malformed asset"}`, { cause: error });
    }
}
