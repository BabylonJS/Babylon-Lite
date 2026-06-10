/** Thin instances — CPU-side data for hardware-instanced rendering.
 *  Each instance carries a world matrix (16 floats) and optionally a
 *  per-instance color (4 floats). The render system creates and syncs
 *  GPU buffers automatically via version tracking. */

import { F32 } from "../engine/typed-arrays.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "./mesh.js";

/** CPU-side data backing a thin-instanced mesh: world matrices, optional colors, and GPU sync state. */
export interface ThinInstanceData {
    /** CPU-side instance world matrices (16 floats per instance). Storage may
     *  be Float32Array (default) or Float64Array (after an HPM engine is
     *  constructed; the caller built the slab via `allocateMat4()`). The GPU
     *  upload path in thin-instance-gpu.ts handles both (REQ-API-3, D5). */
    matrices: Float32Array | Float64Array;
    /** Active instance count. */
    count: number;
    /** @internal Allocated capacity (in instances). */
    _capacity: number;
    /** @internal Version counter — bumped by helpers, checked by render system. */
    _version: number;
    /** @internal GPU buffer — created and managed by render system, not user. */
    _gpuBuffer: GPUBuffer | null;
    /** @internal Whether the current matrix GPU buffer was created with STORAGE usage. */
    _gpuBufferStorage: boolean;
    /** @internal Last version uploaded to GPU. */
    _gpuVersion: number;

    /** @internal Min dirty instance index (inclusive). */
    _dirtyMin: number;
    /** @internal Max dirty instance index (exclusive). */
    _dirtyMax: number;

    /** Optional per-instance RGBA colors (4 floats per instance). */
    colors?: Float32Array | null;
    /** @internal Color version counter — independent of matrix version. */
    _colorVersion: number;
    /** @internal GPU buffer for per-instance colors. */
    _colorGpuBuffer: GPUBuffer | null;
    /** @internal Whether the current color GPU buffer was created with STORAGE usage. */
    _colorGpuBufferStorage: boolean;
    /** @internal Last color version uploaded to GPU. */
    _colorGpuVersion: number;

    /** @internal Lazy per-mesh F32 upload scratch. Allocated by thin-instance-gpu.ts only
     *  when `matrices` is F64-backed (HPM-on); F32-backed input takes a direct
     *  writeBuffer fast-path. Sized in floats = `_capacity * 16`. */
    _uploadF32?: Float32Array;

    /** @internal Opt-in flag for GPU frustum culling + indirect drawing. */
    _gpuCullingEnabled: boolean;
}

/** Set all instances from a pre-built matrix array. */
export function setThinInstances(mesh: Mesh, matrices: Float32Array | Float64Array, count: number): void {
    if (!mesh.thinInstances) {
        mesh.thinInstances = {
            matrices,
            count,
            _capacity: count,
            _version: 1,
            _gpuBuffer: null,
            _gpuBufferStorage: false,
            _gpuVersion: 0,
            _dirtyMin: 0,
            _dirtyMax: count,
            _colorVersion: 0,
            _colorGpuBuffer: null,
            _colorGpuBufferStorage: false,
            _colorGpuVersion: 0,
            _gpuCullingEnabled: false,
        };
    } else {
        mesh.thinInstances.matrices = matrices;
        mesh.thinInstances.count = count;
        mesh.thinInstances._capacity = count;
        mesh.thinInstances._version++;
        mesh.thinInstances._dirtyMin = 0;
        mesh.thinInstances._dirtyMax = count;
    }
}

/** Update ONLY the active instance count (and re-upload the [0,count) matrix range), leaving `_capacity`
 *  — and therefore the already-allocated GPU buffer — untouched. This is the way to vary how many instances
 *  draw FRAME-TO-FRAME on an established thin-instanced mesh WITHOUT recreating the GPU buffer (which would
 *  invalidate any cached render/shadow bundle that captured the old buffer handle). Pre-size the buffer once
 *  with `setThinInstances(mesh, matrices, capacity)`, then call this each update with `count <= capacity`.
 *  The draw reads `count` live, so the bundle stays valid. Caller must keep writing into the SAME `matrices`
 *  array the mesh already references. No-op if the mesh isn't thin-instanced yet. */
export function setThinInstanceCount(mesh: Mesh, count: number): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        return;
    }
    ti.count = count;
    ti._version++;
    ti._dirtyMin = 0;
    ti._dirtyMax = count;
}

/** Add one instance. Returns its index. Grows capacity as needed. */
export function addThinInstance(mesh: Mesh, matrix: Mat4): number {
    const ti = mesh.thinInstances;
    if (!ti) {
        const capacity = 16;
        const matrices = new F32(capacity * 16);
        matrices.set(matrix, 0);
        mesh.thinInstances = {
            matrices,
            count: 1,
            _capacity: capacity,
            _version: 1,
            _gpuBuffer: null,
            _gpuBufferStorage: false,
            _gpuVersion: 0,
            _dirtyMin: 0,
            _dirtyMax: 1,
            _colorVersion: 0,
            _colorGpuBuffer: null,
            _colorGpuBufferStorage: false,
            _colorGpuVersion: 0,
            _gpuCullingEnabled: false,
        };
        return 0;
    }

    const index = ti.count;
    if (index >= ti._capacity) {
        const newCap = ti._capacity * 2;
        const newData = new F32(newCap * 16);
        newData.set(ti.matrices);
        ti.matrices = newData;
        ti._capacity = newCap;
    }

    ti.matrices.set(matrix, index * 16);
    ti.count++;
    ti._version++;
    ti._dirtyMin = 0;
    ti._dirtyMax = ti.count;
    return index;
}

/** Update one instance's matrix. */
export function setThinInstanceMatrix(mesh: Mesh, index: number, matrix: Mat4): void {
    const ti = mesh.thinInstances!;
    ti.matrices.set(matrix, index * 16);
    ti._version++;
    ti._dirtyMin = Math.min(ti._dirtyMin, index);
    ti._dirtyMax = Math.max(ti._dirtyMax, index + 1);
}

/** Remove instance by index. Swap-removes: last instance fills the gap. */
export function removeThinInstance(mesh: Mesh, index: number): void {
    const ti = mesh.thinInstances!;
    const last = ti.count - 1;
    if (index !== last) {
        ti.matrices.copyWithin(index * 16, last * 16, last * 16 + 16);
    }
    ti.count--;
    ti._version++;
    ti._dirtyMin = 0;
    ti._dirtyMax = ti.count;
}

/** Mark thin instance data dirty after direct array manipulation. */
export function flushThinInstances(mesh: Mesh): void {
    const ti = mesh.thinInstances!;
    ti._version++;
    ti._dirtyMin = 0;
    ti._dirtyMax = ti.count;
}

/** Set per-instance RGBA colors for a thin-instanced mesh. */
export function setThinInstanceColors(mesh: Mesh, colors: Float32Array): void {
    const ti = mesh.thinInstances!;
    ti.colors = colors;
    ti._colorVersion++;
}

/** Enable or disable GPU frustum culling for an existing thin-instanced mesh.
 *
 * Call this after `setThinInstances()`/`addThinInstance()` and before `registerScene()`.
 * The render system keeps the feature opt-in so non-culled thin-instance scenes do not
 * fetch the compute-culling module or allocate compacted visible-instance buffers.
 */
export function enableThinInstanceGpuCulling(mesh: Mesh, enabled = true): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        throw new Error("enableThinInstanceGpuCulling requires mesh.thinInstances");
    }
    if (ti._gpuCullingEnabled === enabled) {
        return;
    }
    ti._gpuCullingEnabled = enabled;
    ti._gpuVersion = -1;
    ti._colorGpuVersion = -1;
}
