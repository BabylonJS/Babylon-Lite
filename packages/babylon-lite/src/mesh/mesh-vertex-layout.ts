import type { MeshVbLayout } from "./mesh.js";

/** @internal Unknown shader attributes must not inherit object prototype properties. */
export function createMeshVertexLayout<T extends MeshVbLayout>(attributes: T): T {
    return Object.assign(Object.create(null) as T, attributes);
}
