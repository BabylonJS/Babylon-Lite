import { createNavMeshHelper, createSearchNodesHelper, createNavMeshOffMeshConnectionsHelper } from "navcat";
import type { NavcatManager, NavcatDebugOptions, NavcatDebugGeometry } from "./navcat-types.js";
import { checkNavcatVersion } from "./navcat-state.js";

export function debug(manager: NavcatManager, version: number, options: NavcatDebugOptions): NavcatDebugGeometry[] {
    const mesh = checkNavcatVersion(manager, version);
    if (options.search && (options.search._owner !== manager || options.search.revision !== manager._revision)) {
        throw new Error("Navcat search result is stale or belongs to another manager");
    }
    const result: NavcatDebugGeometry[] = [];
    function append(primitives: ReturnType<typeof createNavMeshHelper>): void {
        for (const primitive of primitives) {
            if (primitive.type !== 0 && primitive.type !== 1 && primitive.type !== 2) {
                throw new Error("Unsupported Navcat debug primitive");
            }
            const positions = new Float32Array(primitive.positions.length);
            for (let i = 0; i < positions.length; i++) {
                positions[i] = i % 3 === 2 ? -primitive.positions[i]! : primitive.positions[i]!;
            }
            result.push({
                kind: primitive.type === 0 ? "triangles" : primitive.type === 1 ? "lines" : "points",
                positions,
                colors: new Float32Array(primitive.colors),
                ...(primitive.type === 0 ? { indices: new Uint32Array(primitive.indices) } : {}),
            });
        }
    }
    if (options.navMesh) {
        append(createNavMeshHelper(mesh));
    }
    if (options.connections) {
        append(createNavMeshOffMeshConnectionsHelper(mesh));
    }
    if (options.search?._search) {
        append(createSearchNodesHelper(options.search._search));
    }
    return result;
}
