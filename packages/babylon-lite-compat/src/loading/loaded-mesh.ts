/**
 * Canonical, stable-identity compat wrappers for the meshes a loader produces.
 *
 * Babylon.js loaders return a flat `meshes` array of real `AbstractMesh` objects
 * (with the synthetic `__root__` at index 0) that apps routinely post-process —
 * reparent, clone, toggle `isVisible`/`setEnabled`, dispose. Babylon Lite returns
 * a root-node hierarchy. We reconstruct that hierarchy as canonical compat
 * `Mesh` wrappers, then flatten the wrappers in hierarchy order so the full
 * transform / visibility / clone / dispose surface is available rather than a
 * stripped read-only handle.
 *
 * **Stable identity.** The wrappers are memoized per Lite node in a registry the
 * `AssetContainer` owns, so `container.meshes[0] === container.meshes[0]` and the
 * same handle is shared with `scene.meshes` — matching Babylon.js, where a loaded
 * mesh is a single canonical object.
 *
 * The wrappers never re-insert into the scene (the loader already added the whole
 * container) and never override the natively-loaded material (`Mesh._fromLite`
 * adopts the Lite node as-is). Bounds are reported in the node's **local**
 * geometry space (`AbstractMesh.getBoundingInfo`), matching how Babylon Lite's own
 * `createDefaultCamera` frames loaded models.
 */

import type { AssetContainer as LiteAssetContainer, Mesh as LiteMesh } from "babylon-lite";

import { Mesh } from "../meshes/meshes.js";
import type { Scene } from "../scene/scene.js";

/** @internal Per-node wrapper cache giving loaded meshes stable identity across `.meshes` reads. */
export type LoadedMeshRegistry = Map<unknown, Mesh>;

/**
 * Wrap every node a loaded Babylon Lite asset container exposes as a canonical
 * compat `Mesh`, reusing the cached wrapper for a node when one already exists (so
 * repeated reads return identical handles). When a `scene` is supplied, each
 * wrapper is bound to it (surfaced through `scene.meshes` and given scene-aware
 * disposal).
 *
 * Babylon.js places a synthetic `__root__` transform node at `result.meshes[0]`
 * (the renderable meshes follow it). Babylon Lite builds the same root
 * (`entities[0]` for glTF) but `getContainerMeshes` returns only renderable
 * meshes, so we prepend that root at index 0 to mirror Babylon.js — as a real,
 * non-renderable `Mesh`, exactly as Babylon.js's `__root__` is a `Mesh`.
 */
export function collectLoadedMeshes(container: LiteAssetContainer, registry: LoadedMeshRegistry, scene?: Scene): Mesh[] {
    const result: Mesh[] = [];
    const visited = new Set<unknown>();
    const visit = (node: unknown, parent: Mesh | null): void => {
        if (visited.has(node)) {
            return;
        }
        const lite = node as { _gpu?: unknown; children?: unknown[] };
        if (!lite._gpu && !Array.isArray(lite.children)) {
            return;
        }
        visited.add(node);
        let wrapper = registry.get(node);
        if (!wrapper || (scene && wrapper.getScene() !== scene)) {
            wrapper = Mesh._fromLiteHierarchy(node as LiteMesh, container, scene, registry, parent);
        }
        result.push(wrapper);
        for (const child of lite.children ?? []) {
            visit(child, wrapper);
        }
    };
    for (const entity of container.entities) {
        visit(entity, null);
    }
    return result;
}
