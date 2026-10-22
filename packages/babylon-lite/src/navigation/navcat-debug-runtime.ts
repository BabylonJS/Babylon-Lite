import { createNavMeshHelper, createSearchNodesHelper, createNavMeshOffMeshConnectionsHelper } from "navcat";
import type { NavcatManager, NavcatDebugOptions, NavcatDebugGeometry } from "./navcat-types.js";
import { checkNavcatVersion } from "./navcat-state.js";

export function debug(manager: NavcatManager, version: number, options: NavcatDebugOptions): NavcatDebugGeometry[] {
    const mesh = checkNavcatVersion(manager, version);
    if (options.search && (options.search._owner !== manager || options.search.revision !== manager._revision)) {
        throw new Error("Navcat search result is stale or belongs to another manager");
    }
    const primitives = [
        ...(options.navMesh ? createNavMeshHelper(mesh) : []),
        ...(options.connections ? createNavMeshOffMeshConnectionsHelper(mesh) : []),
        ...(options.search?._search ? createSearchNodesHelper(options.search._search) : []),
    ];
    return primitives.map((primitive) => {
        if (primitive.type !== 0 && primitive.type !== 1 && primitive.type !== 2) {
            throw new Error("Unsupported Navcat debug primitive");
        }
        return {
            kind: primitive.type === 0 ? "triangles" : primitive.type === 1 ? "lines" : "points",
            positions: Float64Array.from(primitive.positions, (value, index) => (index % 3 === 2 ? -value : value)),
            colors: new Float32Array(primitive.colors),
            ...(primitive.type === 0 ? { indices: new Uint32Array(primitive.indices) } : {}),
        };
    });
}
