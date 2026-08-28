import { F32 } from "../engine/typed-arrays.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4, Mat4Storage } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mesh } from "./mesh.js";
import { setThinInstanceCount, setThinInstances } from "./thin-instance.js";

/** @internal */
export interface HierarchyInstancePoolBinding {
    mesh: Mesh;
    matrices: Float32Array;
    /** @internal */
    _meshWorldInverse: Mat4Storage;
    /** @internal */
    _meshWorld: Mat4Storage;
}

/**
 * A fixed-capacity thin-instance pool for a transform-node hierarchy.
 *
 * The source meshes become the render carriers for the pool: each descendant
 * mesh receives its own thin-instance matrix buffer, and one logical hierarchy
 * instance updates the matching slot in every buffer.
 *
 * An instance matrix composes with the template's own world matrices, exactly
 * like adding a parent transform node above the hierarchy root: the identity
 * matrix reproduces the template unchanged.
 */
export interface HierarchyInstancePool {
    /** Template hierarchy root used to build the pool. */
    readonly root: SceneNode;
    /** Maximum number of logical hierarchy instances that can be active. */
    readonly capacity: number;
    /** Descendant meshes driven by this pool. */
    readonly meshes: readonly Mesh[];
    /**
     * Current active logical hierarchy instance count.
     * Prefer {@link addHierarchyInstance}, {@link removeHierarchyInstance}, and
     * {@link setHierarchyInstanceCount} over mutating this field directly.
     */
    count: number;
    /** @internal */
    readonly _bindings: readonly HierarchyInstancePoolBinding[];
    /** @internal */
    readonly _scratch: Float32Array;
}

/**
 * Build a fixed-capacity thin-instance pool from a template hierarchy.
 *
 * Call before `registerScene()`, after the hierarchy's parent links are
 * established. Fresh `loadGltf()` hierarchies are also supported: this helper
 * materializes child parent links from the `children` arrays before snapshotting
 * template world matrices.
 *
 * The template meshes are converted to thin-instanced meshes with an active
 * count of zero, so they do not draw until instances are added.
 *
 * @param root - Root transform node or mesh for the template hierarchy.
 * @param capacity - Maximum number of active logical hierarchy instances.
 */
export function createHierarchyInstancePool(root: SceneNode, capacity: number): HierarchyInstancePool {
    if (!Number.isInteger(capacity) || capacity < 0) {
        throw new Error("createHierarchyInstancePool capacity must be a non-negative integer");
    }

    const meshes: Mesh[] = [];
    collectMeshes(root, meshes);
    if (meshes.length === 0) {
        throw new Error("createHierarchyInstancePool requires at least one mesh in the source hierarchy");
    }

    const bindings: HierarchyInstancePoolBinding[] = [];
    for (const mesh of meshes) {
        if (mesh.thinInstances) {
            throw new Error(`createHierarchyInstancePool mesh "${mesh.name}" already has thin instances`);
        }

        const meshWorld = copyMat4(mesh.worldMatrix);
        const meshWorldInverse = mat4Invert(meshWorld as unknown as Mat4);
        if (!meshWorldInverse) {
            throw new Error(`createHierarchyInstancePool requires an invertible world matrix for mesh "${mesh.name}"`);
        }

        const matrices = new F32(capacity * 16);
        setThinInstances(mesh, matrices, capacity);
        setThinInstanceCount(mesh, 0);
        bindings.push({
            mesh,
            matrices,
            _meshWorldInverse: meshWorldInverse as unknown as Mat4Storage,
            _meshWorld: meshWorld,
        });
    }

    return {
        root,
        capacity,
        meshes,
        count: 0,
        _bindings: bindings,
        _scratch: new F32(16),
    };
}

/**
 * Add one logical hierarchy instance and return its slot index.
 *
 * The same root matrix is expanded into each descendant mesh's thin-instance
 * buffer so child offsets, rotations, and scales are preserved. It composes with
 * the template hierarchy rather than replacing the root world matrix, so the
 * identity matrix draws the template where it already is.
 *
 * @param pool - Pool created by {@link createHierarchyInstancePool}.
 * @param matrix - World-space transform applied on top of the template hierarchy.
 */
export function addHierarchyInstance(pool: HierarchyInstancePool, matrix: Mat4): number {
    const index = pool.count;
    if (index >= pool.capacity) {
        throw new Error("addHierarchyInstance exceeded pool capacity");
    }

    for (let b = 0; b < pool._bindings.length; b++) {
        writeBindingMatrix(pool, pool._bindings[b]!, index, matrix);
    }
    setHierarchyInstanceCount(pool, index + 1);
    return index;
}

/**
 * Update one logical hierarchy instance's root matrix.
 *
 * @param pool - Pool created by {@link createHierarchyInstancePool}.
 * @param index - Active logical instance index to update.
 * @param matrix - World-space transform applied on top of the template hierarchy.
 */
export function setHierarchyInstanceMatrix(pool: HierarchyInstancePool, index: number, matrix: Mat4): void {
    assertActiveIndex(pool, index, "setHierarchyInstanceMatrix");
    for (let b = 0; b < pool._bindings.length; b++) {
        const binding = pool._bindings[b]!;
        writeBindingMatrix(pool, binding, index, matrix);
        markMatrixDirty(binding, index);
    }
}

/**
 * Remove one logical hierarchy instance with O(1) swap-remove semantics.
 *
 * If `index` is not the last active slot, the last logical instance moves into
 * `index` in every descendant mesh buffer.
 *
 * @param pool - Pool created by {@link createHierarchyInstancePool}.
 * @param index - Active logical instance index to remove.
 */
export function removeHierarchyInstance(pool: HierarchyInstancePool, index: number): void {
    assertActiveIndex(pool, index, "removeHierarchyInstance");

    const last = pool.count - 1;
    if (index !== last) {
        const dst = index * 16;
        const src = last * 16;
        for (let b = 0; b < pool._bindings.length; b++) {
            pool._bindings[b]!.matrices.copyWithin(dst, src, src + 16);
        }
    }
    setHierarchyInstanceCount(pool, last);
}

/**
 * Set the active logical hierarchy instance count without reallocating buffers.
 *
 * This mirrors {@link setThinInstanceCount}: it only changes how many existing
 * slots draw. Newly exposed slots are not initialized here; use
 * {@link addHierarchyInstance} when growing with a new matrix, or immediately
 * call {@link setHierarchyInstanceMatrix} before the next frame.
 *
 * @param pool - Pool created by {@link createHierarchyInstancePool}.
 * @param count - New active logical instance count, from 0 to `pool.capacity`.
 */
export function setHierarchyInstanceCount(pool: HierarchyInstancePool, count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > pool.capacity) {
        throw new Error("setHierarchyInstanceCount count must be an integer within pool capacity");
    }
    for (let b = 0; b < pool._bindings.length; b++) {
        const binding = pool._bindings[b]!;
        if (!binding.mesh.thinInstances) {
            throw new Error(`setHierarchyInstanceCount mesh "${binding.mesh.name}" is missing thin instance data`);
        }
        setThinInstanceCount(binding.mesh, count);
    }
    pool.count = count;
}

function collectMeshes(node: SceneNode, meshes: Mesh[]): void {
    if (isMesh(node)) {
        meshes.push(node);
    }
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
        const child = kids[i]!;
        if (child.parent !== node) {
            child.parent = node;
        }
        collectMeshes(child, meshes);
    }
}

function isMesh(node: SceneNode): node is Mesh {
    return "_gpu" in node && "material" in node;
}

function copyMat4(src: Mat4): Float32Array {
    const dst = new F32(16);
    dst.set(src as unknown as Mat4Storage);
    return dst;
}

// The shader draws each thin instance at `finalWorld = mesh.world * instanceMatrix`, so the stored
// matrix is `meshWorld⁻¹ * rootMatrix * meshWorld`. That composes the requested transform on top of
// the template's own world matrices (`finalWorld = rootMatrix * meshWorld`) instead of replacing the
// root world, which would cancel transforms the hierarchy legitimately carries — such as the glTF
// `__root__` RH→LH `(-1, 1, 1)` flip.
function writeBindingMatrix(pool: HierarchyInstancePool, binding: HierarchyInstancePoolBinding, index: number, rootMatrix: Mat4): void {
    const rootStorage = rootMatrix as unknown as Mat4Storage;
    mat4MultiplyInto(pool._scratch, 0, rootStorage, 0, binding._meshWorld, 0);
    mat4MultiplyInto(binding.matrices, index * 16, binding._meshWorldInverse, 0, pool._scratch, 0);
}

function markMatrixDirty(binding: HierarchyInstancePoolBinding, index: number): void {
    const ti = binding.mesh.thinInstances;
    if (!ti) {
        throw new Error(`HierarchyInstancePool mesh "${binding.mesh.name}" is missing thin instance data`);
    }
    ti._version++;
    ti._dirtyMin = Math.min(ti._dirtyMin, index);
    ti._dirtyMax = Math.max(ti._dirtyMax, index + 1);
}

function assertActiveIndex(pool: HierarchyInstancePool, index: number, caller: string): void {
    if (!Number.isInteger(index) || index < 0 || index >= pool.count) {
        throw new Error(`${caller} index must reference an active hierarchy instance`);
    }
}
