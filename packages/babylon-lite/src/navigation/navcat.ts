import type { NavcatManager, NavcatOptions, NavcatFilter } from "./navcat-types.js";
import { assertNavcatIdle, copyNavcatFilter, copyNavcatVector, navcatMesh } from "./navcat-state.js";
import { parseNavcatMesh, stringifyNavcatMesh } from "./navcat-json.js";

/** Load an exclusively owned versioned Navcat 0.4.1 asset. Loads query code only; no Wasm or generator. */
export async function createNavcatManager(json: string, options: NavcatOptions = {}): Promise<NavcatManager> {
    assertNavcatIdle();
    const filter = copyNavcatFilter(options.filter);
    const halfExtents = copyNavcatVector(options.halfExtents ?? { x: 1, y: 2, z: 1 }, "half extents", true);
    const mesh = parseNavcatMesh(json);
    const api = await import("./navcat-runtime.js");
    return {
        backend: "navcat",
        _mesh: mesh,
        _api: api,
        _filter: filter,
        _queryFilter: api.createQueryFilter(filter),
        _halfExtents: halfExtents,
        _halfExtentsTuple: [halfExtents.x, halfExtents.y, halfExtents.z],
        _revision: 0,
        _meshVersion: 0,
        _disposed: false,
    };
}

/** Atomically replace the owned mesh; invalid JSON leaves the previous graph intact. */
export function replaceNavcatMesh(manager: NavcatManager, json: string): void {
    assertNavcatIdle();
    navcatMesh(manager);
    const mesh = parseNavcatMesh(json);
    manager._mesh = mesh;
    manager._revision++;
    manager._meshVersion++;
}

/** Export a fresh versioned asset string, including current connections. */
export function exportNavcatMesh(manager: NavcatManager): string {
    assertNavcatIdle();
    return stringifyNavcatMesh(navcatMesh(manager));
}

/** Copy filter options, preserving callback identity. Null restores the default filter. */
export function setNavcatFilter(manager: NavcatManager, filter: NavcatFilter | null): void {
    assertNavcatIdle();
    navcatMesh(manager);
    const copy = copyNavcatFilter(filter);
    manager._queryFilter = manager._api!.createQueryFilter(copy);
    manager._filter = copy;
}

/** Idempotently release owned mesh data and callback references. Later queries throw. */
export function disposeNavcatManager(manager: NavcatManager): void {
    if (manager._disposed) {
        return;
    }
    assertNavcatIdle();
    manager._disposed = true;
    manager._revision++;
    manager._meshVersion++;
    manager._mesh = null;
    manager._api = null;
    manager._filter = null;
    manager._queryFilter = null;
    manager._halfExtents = null;
    manager._halfExtentsTuple = null;
}
