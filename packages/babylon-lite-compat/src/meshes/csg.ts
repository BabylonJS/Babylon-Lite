/**
 * Babylon.js `CSG` (legacy) and `CSG2` (Manifold-based) constructive solid
 * geometry, wrapped over Babylon Lite's native CSG API.
 *
 * Babylon.js exposes two object-oriented CSG surfaces:
 *   - `CSG.FromMesh(mesh)` → `.subtract` / `.intersect` / `.union` → `.toMesh(name, material, scene)`
 *   - `CSG2.FromMesh(mesh)` → `.subtract` / `.intersect` / `.add` → `.toMesh(name, scene)` (+ `.dispose()`),
 *     after `await InitializeCSG2Async()`.
 *
 * Babylon Lite ships the equivalent as standalone functions
 * (`createCsgFromMesh` / `csgSubtract` / … / `createMeshFromCsg`, and the CSG2
 * `createCsg2FromMesh` / `csg2Subtract` / … / `createMeshesFromCsg2`). These
 * classes adapt the function API to Babylon.js's method-chaining shape.
 *
 * CSG (legacy) `toMesh` takes an explicit material and produces a single mesh.
 * CSG2 preserves per-source materials: each `FromMesh` records its source mesh's
 * material against a unique slot, operations union those slot→material maps, and
 * `toMesh` triangulates into one Lite mesh per slot (`createMeshesFromCsg2`),
 * returning a single compat `Mesh` with the remaining sub-meshes parented under it
 * so positioning the result moves them together — matching Babylon.js's single
 * multi-material `toMesh` return.
 */

import {
    createCsgFromMesh,
    csgSubtract,
    csgIntersect,
    csgUnion,
    createMeshFromCsg,
    initializeCsg2Async,
    createCsg2FromMesh,
    csg2Subtract,
    csg2Intersect,
    csg2Add,
    createMeshesFromCsg2,
    disposeCsg2,
    addToScene,
    type CsgSolid,
    type Csg2Solid,
    type Material as LiteMaterial,
} from "babylon-lite";

import { Mesh } from "./meshes.js";
import type { Scene } from "../scene/scene.js";
import type { StandardMaterial, PBRMaterial } from "../materials/materials.js";
import type { NodeMaterial } from "../materials/node-material.js";

type CompatMaterial = StandardMaterial | PBRMaterial | NodeMaterial;

/** A compat mesh exposes its backing Lite mesh as `_lite`. */
interface MeshLike {
    _lite: import("babylon-lite").Mesh;
}

/** @internal Add a freshly-built CSG result mesh to its scene at engine start. */
function deferAddCsgMesh(mesh: Mesh, scene: Scene, material?: CompatMaterial): void {
    scene._deferAdd(() => {
        const engine = scene.getEngine()._lite;
        if (material) {
            material._ensureRenderable(engine);
            mesh._lite.material = material._lite as never;
        }
        addToScene(scene._lite, mesh._lite);
    });
}

/**
 * Babylon.js `CSG` — legacy constructive solid geometry. Build from a mesh with
 * {@link FromMesh}, combine with {@link subtract} / {@link intersect} /
 * {@link union}, then materialize with {@link toMesh}.
 */
export class CSG {
    private constructor(private readonly _lite: CsgSolid) {}

    /** Babylon.js `CSG.FromMesh(mesh)`. */
    public static FromMesh(mesh: MeshLike): CSG {
        return new CSG(createCsgFromMesh(mesh._lite));
    }

    /** Babylon.js `csg.subtract(other)` — `this − other`. */
    public subtract(other: CSG): CSG {
        return new CSG(csgSubtract(this._lite, other._lite));
    }

    /** Babylon.js `csg.intersect(other)`. */
    public intersect(other: CSG): CSG {
        return new CSG(csgIntersect(this._lite, other._lite));
    }

    /** Babylon.js `csg.union(other)`. */
    public union(other: CSG): CSG {
        return new CSG(csgUnion(this._lite, other._lite));
    }

    /** Babylon.js `csg.toMesh(name, material, scene)` — triangulate into a single mesh. */
    public toMesh(name: string, material: CompatMaterial | null, scene: Scene): Mesh {
        const engine = scene.getEngine()._lite;
        const lite = createMeshFromCsg(engine, this._lite, name);
        const mesh = new Mesh(name, lite, scene);
        deferAddCsgMesh(mesh, scene, material ?? undefined);
        return mesh;
    }
}

/** Module-wide unique material-slot counter for CSG2 (`MATERIAL_ID_RESERVE_COUNT` = 65536). */
let nextCsg2Slot = 0;

/**
 * Babylon.js `CSG2` — Manifold-based constructive solid geometry that preserves
 * per-source-mesh materials. Call `await InitializeCSG2Async()` once before use.
 */
export class CSG2 {
    private constructor(
        private readonly _lite: Csg2Solid,
        /** Slot → source material, accumulated across operations. */
        private readonly _materials: Map<number, CompatMaterial>
    ) {}

    /** Babylon.js `CSG2.FromMesh(mesh)` — records the mesh's material against a unique slot. */
    public static FromMesh(mesh: MeshLike & { material?: CompatMaterial | null }): CSG2 {
        const slot = nextCsg2Slot++;
        const materials = new Map<number, CompatMaterial>();
        if (mesh.material) {
            materials.set(slot, mesh.material);
        }
        return new CSG2(createCsg2FromMesh(mesh._lite, slot), materials);
    }

    private _combine(lite: Csg2Solid, other: CSG2): CSG2 {
        const materials = new Map(this._materials);
        for (const [slot, material] of other._materials) {
            materials.set(slot, material);
        }
        return new CSG2(lite, materials);
    }

    /** Babylon.js `csg.subtract(other)` — `this − other`. */
    public subtract(other: CSG2): CSG2 {
        return this._combine(csg2Subtract(this._lite, other._lite), other);
    }

    /** Babylon.js `csg.intersect(other)`. */
    public intersect(other: CSG2): CSG2 {
        return this._combine(csg2Intersect(this._lite, other._lite), other);
    }

    /** Babylon.js `csg.add(other)` — union. */
    public add(other: CSG2): CSG2 {
        return this._combine(csg2Add(this._lite, other._lite), other);
    }

    /**
     * Babylon.js `csg.toMesh(name, scene)` — triangulate into a single mesh,
     * preserving each source mesh's material across the result's faces.
     */
    public toMesh(name: string, scene: Scene): Mesh {
        const engine = scene.getEngine()._lite;
        // Build a slot-indexed Lite material array (sparse; only referenced slots are read).
        const materials: LiteMaterial[] = [];
        for (const [slot, material] of this._materials) {
            material._ensureRenderable(engine);
            materials[slot] = material._lite as never;
        }
        const liteMeshes = createMeshesFromCsg2(engine, this._lite, materials, name);
        // `createMeshesFromCsg2` already assigned each sub-mesh its Lite material; wrapping
        // the first in a compat `Mesh` clobbers it with the scene default, so restore it.
        const savedMaterials = liteMeshes.map((m) => m.material);
        const root = new Mesh(name, liteMeshes[0]!, scene);
        root._lite.material = savedMaterials[0] as never;
        scene._deferAdd(() => addToScene(scene._lite, root._lite));
        // Parent the remaining material sub-meshes under the returned mesh so the whole
        // result moves as one (Babylon.js returns a single multi-material mesh).
        for (let i = 1; i < liteMeshes.length; i++) {
            const sub = liteMeshes[i]!;
            sub.material = savedMaterials[i] as never;
            (sub as unknown as { parent: unknown }).parent = root._lite;
            scene._deferAdd(() => addToScene(scene._lite, sub));
        }
        return root;
    }

    /** Babylon.js `csg.dispose()` — release the underlying Manifold solid. */
    public dispose(): void {
        disposeCsg2(this._lite);
    }
}

/** Babylon.js `InitializeCSG2Async()` — load the Manifold runtime before any `CSG2` use. */
export async function InitializeCSG2Async(): Promise<void> {
    await initializeCsg2Async();
}
