/**
 * Lightweight handles for meshes produced by the loaders (`ImportMeshAsync` etc.).
 *
 * Babylon.js loaders return a flat `meshes` array whose entries expose
 * `getBoundingInfo()` (with min/max), `refreshBoundingInfo()`, and
 * `getVerticesData()` — used by scenes to frame a camera around a loaded model.
 * Babylon Lite returns a root-node hierarchy; the tree-shakeable
 * `getContainerMeshes` helper flattens it to its renderable `Mesh` nodes, which we
 * wrap here.
 *
 * Bounds are reported in the node's **local** geometry space (`mesh.boundMin` /
 * `mesh.boundMax`), matching how Babylon Lite's own `createDefaultCamera` frames
 * loaded models — it reads the same local bounds without applying the node world
 * matrix, and the renderer (notably for skinned meshes) draws at that same local
 * scale. Returning world-transformed bounds here would make the camera-framing
 * math in model-viewer scenes disagree with the Lite render.
 */

import { getContainerMeshes } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer, Mesh as LiteMesh } from "babylon-lite";

import { Vector3 } from "../math/vector.js";
import { BoundingInfo } from "../culling/bounding.js";

/**
 * A Babylon.js-shaped handle over a single loaded Babylon Lite mesh. Exposes the
 * subset used by model-framing scenes: local bounding info, vertex data, and name.
 */
export class LoadedMesh {
    public readonly name: string;
    private readonly _mesh: LiteMesh;
    /** @internal The asset container this mesh was loaded from (for `KHR_materials_variants`). */
    public readonly _container: LiteAssetContainer | undefined;

    public constructor(mesh: LiteMesh, container?: LiteAssetContainer) {
        this._mesh = mesh;
        this.name = mesh.name ?? "";
        this._container = container;
    }

    /** @internal The underlying Babylon Lite mesh (e.g. for the navmesh wrapper's geometry merge). */
    public get _lite(): LiteMesh {
        return this._mesh;
    }

    /** Babylon.js `refreshBoundingInfo()` — bounds are read on demand, so this is a no-op. */
    public refreshBoundingInfo(_options?: unknown): LoadedMesh {
        return this;
    }

    /** Babylon.js `getBoundingInfo()` — local-space AABB of this mesh (see module note). */
    public getBoundingInfo(): BoundingInfo {
        const lo = this._mesh.boundMin;
        const hi = this._mesh.boundMax;
        if (lo && hi) {
            return new BoundingInfo(new Vector3(lo[0], lo[1], lo[2]), new Vector3(hi[0], hi[1], hi[2]));
        }
        return new BoundingInfo(new Vector3(0, 0, 0), new Vector3(0, 0, 0));
    }

    /** Babylon.js `getVerticesData(kind)` — CPU position buffer (positions only). */
    public getVerticesData(kind: string): Float32Array | null {
        const positions = this._mesh._cpuPositions;
        return kind === "position" ? (positions ?? null) : null;
    }

    /** Babylon.js `getTotalVertices()`. */
    public getTotalVertices(): number {
        const positions = this._mesh._cpuPositions;
        return positions ? positions.length / 3 : 0;
    }
}

/**
 * Wrap every renderable mesh in a loaded Babylon Lite asset container as a
 * `LoadedMesh`, matching the flat `meshes` array Babylon.js loaders return.
 *
 * Babylon.js loaders place a synthetic `__root__` transform node at
 * `result.meshes[0]` (the renderable meshes follow it). Babylon Lite builds the
 * same `__root__` (`entities[0]` for glTF) but `getContainerMeshes` returns only
 * renderable meshes. Prepend that root so index-based access (`result.meshes[1]`,
 * used by the navigation scenes) lines up with Babylon.js.
 */
export function collectLoadedMeshes(container: LiteAssetContainer): LoadedMesh[] {
    const renderable = getContainerMeshes(container);
    const result: LoadedMesh[] = [];
    // The glTF loader's root is a transform node (no GPU geometry) that parents the
    // renderable meshes — include it at index 0 to mirror Babylon.js `__root__`.
    // Detected as a non-renderable entity that has a `children` array (lights, which
    // BJS `meshes` excludes, are leaf nodes without one).
    for (const entity of container.entities) {
        const node = entity as unknown as { _gpu?: unknown; children?: unknown[] };
        if (!node._gpu && Array.isArray(node.children) && !renderable.includes(entity as unknown as LiteMesh)) {
            result.push(new LoadedMesh(entity as unknown as LiteMesh, container));
        }
    }
    for (const mesh of renderable) {
        result.push(new LoadedMesh(mesh, container));
    }
    return result;
}
