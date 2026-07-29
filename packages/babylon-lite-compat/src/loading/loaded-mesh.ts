/**
 * Canonical, stable-identity compat wrappers for the meshes a loader produces.
 *
 * Babylon.js loaders return a flat `meshes` array of real `AbstractMesh` objects
 * (with the synthetic `__root__` at index 0) that apps routinely post-process —
 * reparent, clone, toggle `isVisible`/`setEnabled`, dispose. Babylon Lite returns
 * a root-node hierarchy; the tree-shakeable `getContainerMeshes` helper flattens
 * it to its renderable `Mesh` nodes. We wrap each loaded node as a real compat
 * `Mesh` (see `meshes.ts`) so that whole transform / visibility / clone / dispose
 * surface is available, rather than a stripped read-only handle.
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

import { getContainerMeshes } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer, Mesh as LiteMesh } from "babylon-lite";

import { Mesh } from "../meshes/meshes.js";
import type { TransformNode } from "../meshes/meshes.js";
import type { Scene } from "../scene/scene.js";

/** @internal Per-node wrapper cache giving loaded meshes stable identity across `.meshes` reads. */
export type LoadedMeshRegistry = Map<unknown, TransformNode>;

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
export function collectLoadedMeshes(container: LiteAssetContainer, registry: LoadedMeshRegistry, scene?: Scene): TransformNode[] {
    const renderable = getContainerMeshes(container);
    const result: TransformNode[] = [];
    const wrap = (node: unknown): TransformNode => {
        let wrapper = registry.get(node);
        if (!wrapper) {
            wrapper = Mesh._fromLite(node as LiteMesh, container, scene);
            registry.set(node, wrapper);
        } else if (scene) {
            wrapper._bindLoadedScene(scene);
        }
        return wrapper;
    };
    // The glTF loader's root is a transform node (no GPU geometry) that parents the
    // renderable meshes — include it at index 0 to mirror Babylon.js `__root__`.
    // Detected as a non-renderable entity that has a `children` array (lights, which
    // BJS `meshes` excludes, are leaf nodes without one).
    for (const entity of container.entities) {
        const node = entity as unknown as { _gpu?: unknown; children?: unknown[] };
        if (!node._gpu && Array.isArray(node.children) && !renderable.includes(entity as unknown as LiteMesh)) {
            result.push(wrap(entity));
        }
    }
    for (const mesh of renderable) {
        result.push(wrap(mesh));
    }
    return result;
}
