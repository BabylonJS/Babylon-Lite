import type { Mesh } from "./mesh.js";

/** Mark caller-managed mesh bounds as changed so cached shadow fits are refreshed. */
export function markMeshBoundsDirty(mesh: Mesh): void {
    mesh._boundsVersion = (mesh._boundsVersion ?? 0) + 1;
}
