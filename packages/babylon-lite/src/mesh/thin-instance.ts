/** Thin instances — CPU-side data for hardware-instanced rendering.
 *  Each instance carries a world matrix (16 floats) and optionally a
 *  per-instance color (4 floats). The render system creates and syncs
 *  GPU buffers automatically via version tracking. */

import { F32 } from "../engine/typed-arrays.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "./mesh.js";
import type { RenderTargetSignature } from "../engine/render-target.js";

/** @internal One render pass's far-bucket output published by the GPU culler for the LOD partner's draw. */
export interface ThinInstanceLodBucket {
    /** Compacted far-bucket instance matrices (vertex + storage usage). */
    matrixBuffer: GPUBuffer;
    /** Compacted far-bucket instance colors, when the culled mesh compacts colors. */
    colorBuffer: GPUBuffer | null;
    /** Indirect draw args for the far bucket (partner indexCount, visible far count). */
    argsBuffer: GPUBuffer;
    /** False while the source mesh's culling is not running — the partner must draw nothing. */
    active: boolean;
}

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
    /** @internal Min dirty color instance index (inclusive) — mirrors the matrix dirty range so
     *  per-instance color updates (setThinInstanceColor) upload only the touched span. */
    _colorDirtyMin: number;
    /** @internal Max dirty color instance index (exclusive). */
    _colorDirtyMax: number;
    /** @internal GPU buffer for per-instance colors. */
    _colorGpuBuffer: GPUBuffer | null;
    /** @internal Whether the current color GPU buffer was created with STORAGE usage. */
    _colorGpuBufferStorage: boolean;
    /** @internal Last color version uploaded to GPU. */
    _colorGpuVersion: number;
    /** @internal Stable indirect args buffer used by cached thin-instance render bundles. */
    _drawArgsBuffer?: GPUBuffer | null;
    /** @internal CPU mirror for the indirect args buffer. */
    _drawArgsData?: Uint32Array;
    /** @internal Last index count written to `_drawArgsBuffer`. */
    _drawArgsIndexCount?: number;
    /** @internal Last instance count observed by a cached direct draw or written to `_drawArgsBuffer`. */
    _drawArgsInstanceCount?: number;

    /** @internal Lazy per-mesh F32 upload scratch. Allocated by thin-instance-gpu.ts only
     *  when `matrices` is F64-backed (HPM-on); F32-backed input takes a direct
     *  writeBuffer fast-path. Sized in floats = `_capacity * 16`. */
    _uploadF32?: Float32Array;

    /** @internal Opt-in flag for GPU frustum culling + indirect drawing. */
    _gpuCullingEnabled: boolean;

    /** @internal Extra world-space radius added to every instance's culling sphere
     *  (see `setThinInstanceCullBoundsPad`). Undefined reads as 0. */
    _cullBoundsPad?: number;
    /** @internal LOD partner mesh receiving this mesh's far bucket (set on the full-detail side). */
    _lodPartner?: Mesh | null;
    /** @internal Camera distance (world units) at which an in-frustum instance moves to the LOD partner. */
    _lodDistance?: number;
    /** @internal Width (world units) of the per-instance threshold dither window (0 = hard cut). */
    _lodBand?: number;
    /** @internal Set on the LOD side: mesh whose culling produces this mesh's drawn instances. */
    _lodSource?: Mesh | null;
    /** @internal Shared per-pass far-bucket outputs for an LOD pair. Its presence also marks both meshes as paired. */
    _lodBuckets?: WeakMap<RenderTargetSignature, ThinInstanceLodBucket> | null;
    /** @internal True when pairing auto-enabled GPU culling on the LOD side (clearing restores it). */
    _lodAutoCull?: boolean;
    /** @internal Extra-owner count when shared with a clone via `cloneTransformNode` — see
     *  resource/ref-count.ts. Absent/undefined means exactly one (implicit) owner. */
    _refCount?: number;
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
            _colorDirtyMin: 0,
            _colorDirtyMax: 0,
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
 *  Count changes promote cached direct draws to stable indirect arguments, so the bundle stays valid.
 *  Caller must keep writing into the SAME `matrices` array the mesh already references. No-op if the mesh
 *  isn't thin-instanced yet. */
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

/** Change only the active instance draw count for an established fixed-capacity pool.
 *
 * Unlike `setThinInstanceCount`, this does not mark matrix or color data dirty. Callers that expose
 * newly written slots must separately mark their exact dirty ranges before the next draw. The pool
 * must have completed an initial full-capacity GPU synchronization. */
export function setThinInstanceDrawCount(mesh: Mesh, count: number): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        return;
    }
    if (!Number.isInteger(count) || count < 0 || count > ti._capacity) {
        throw new RangeError(`Thin instance draw count ${count} must be an integer between 0 and capacity ${ti._capacity}`);
    }
    if (ti.count === count) {
        return;
    }
    if (!ti._gpuBuffer || ti._gpuVersion !== ti._version || (ti.colors && (!ti._colorGpuBuffer || ti._colorGpuVersion !== ti._colorVersion))) {
        throw new Error("setThinInstanceDrawCount requires a fully synchronized fixed-capacity pool");
    }
    ti.count = count;
    ti._gpuVersion = ++ti._version;
}

/** Opt a fixed-capacity thin-instance pool into stable indirect draw arguments before its count changes.
 * The buffer is created on the next normal GPU sync, allowing scene warm-up to absorb its visibility epoch
 * instead of lazily invalidating cached render bundles on the first interactive count transition. */
export function enableThinInstanceDynamicDrawCount(mesh: Mesh): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        throw new Error("enableThinInstanceDynamicDrawCount requires mesh.thinInstances");
    }
    if (!ti._drawArgsBuffer) {
        ti._drawArgsInstanceCount = -1;
    }
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
            _colorDirtyMin: 0,
            _colorDirtyMax: 0,
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
    ti._version++;
    ti._colorVersion++;
    ti._colorDirtyMin = 0;
    ti._colorDirtyMax = ti.count;
}

/** Update ONE instance's RGBA color in place — the color twin of `setThinInstanceMatrix`. Only the
 *  touched span re-uploads (dirty-range), so per-instance color churn (e.g. streamed instances carrying
 *  per-slot animation timestamps) stays cheap on large pools. Requires colors to have been set via
 *  `setThinInstanceColors` first. */
export function setThinInstanceColor(mesh: Mesh, index: number, r: number, g: number, b: number, a: number): void {
    const ti = mesh.thinInstances!;
    const c = ti.colors!;
    const o = index * 4;
    c[o] = r;
    c[o + 1] = g;
    c[o + 2] = b;
    c[o + 3] = a;
    ti._version++;
    ti._colorVersion++;
    ti._colorDirtyMin = Math.min(ti._colorDirtyMin, index);
    ti._colorDirtyMax = Math.max(ti._colorDirtyMax, index + 1);
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

/** Set an extra WORLD-SPACE radius added to every instance's GPU-culling sphere.
 *
 * The culler derives each instance's sphere from the prototype's authored vertex bounds, so a
 * vertex shader that DISPLACES geometry beyond them — terrain-following height offsets, tall wind
 * sway, growth animations — can move a visible instance outside its sphere and pop it at the
 * screen edge. The usual workaround is disabling culling for the whole mesh; padding the sphere
 * by the maximum shader displacement instead keeps culling both correct and enabled.
 *
 * The pad is in world units, applied after per-instance scaling. 0 restores the exact authored
 * bounds. Takes effect on the next culled pass (the culler reads it when writing its per-pass
 * params), so it can be changed live.
 */
export function setThinInstanceCullBoundsPad(mesh: Mesh, pad: number): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        throw new Error("setThinInstanceCullBoundsPad requires mesh.thinInstances");
    }
    ti._cullBoundsPad = pad;
}

/** Options for `setThinInstanceLodPartner`. */
export interface ThinInstanceLodPartnerOptions {
    /** Camera distance (world units) at which an in-frustum instance switches from `fullMesh` to the LOD partner. */
    distance: number;
    /** Width (world units) of a per-instance threshold dither window centered on `distance` (default 0 — hard cut). */
    band?: number;
}

/** Pair a GPU-culled thin-instanced mesh with a lower-detail partner: when `fullMesh`'s compute cull runs,
 * in-frustum instances closer than `options.distance` keep drawing through `fullMesh` while farther ones are
 * compacted into a second bucket drawn by `lodMesh` instead. `lodMesh` must be a normal scene mesh sharing the
 * same thin-instance matrix layout (it may reference the same matrices array); while paired it draws ONLY the
 * far bucket — never its own instance count — so when culling is disabled, unavailable, or the instance count
 * is 0, `fullMesh` falls back to drawing ALL instances and `lodMesh` draws nothing. `options.band` dithers the
 * threshold per instance by ±band/2 via a deterministic hash of the instance index. Like
 * `enableThinInstanceGpuCulling`, call after `setThinInstances()` and before `registerScene()`;
 * `distance`/`band` may be re-set live by calling again with the same pair. */
export function setThinInstanceLodPartner(fullMesh: Mesh, lodMesh: Mesh, options: ThinInstanceLodPartnerOptions): void {
    const ti = fullMesh.thinInstances;
    const lodTi = lodMesh.thinInstances;
    if (!ti || !lodTi) {
        throw new Error("setThinInstanceLodPartner requires thinInstances on both meshes");
    }
    if (fullMesh === lodMesh) {
        throw new Error("setThinInstanceLodPartner requires two distinct meshes");
    }
    if ((ti._refCount ?? 1) > 1 || (lodTi._refCount ?? 1) > 1) {
        throw new Error("setThinInstanceLodPartner does not support thin-instance data shared by mesh clones");
    }
    if (!Number.isFinite(options.distance) || options.distance < 0) {
        throw new RangeError("setThinInstanceLodPartner distance must be a finite non-negative number");
    }
    const band = options.band ?? 0;
    if (!Number.isFinite(band) || band < 0) {
        throw new RangeError("setThinInstanceLodPartner band must be a finite non-negative number");
    }
    if (ti._lodSource) {
        throw new Error("setThinInstanceLodPartner fullMesh cannot already be an LOD partner");
    }
    if (lodTi._lodPartner) {
        throw new Error("setThinInstanceLodPartner lodMesh cannot also own an LOD partner");
    }
    if (lodTi._lodSource && lodTi._lodSource !== fullMesh) {
        throw new Error("setThinInstanceLodPartner lodMesh is already paired with another source mesh");
    }
    if (lodTi.colors && !ti.colors) {
        throw new Error("setThinInstanceLodPartner requires source instance colors when the LOD partner uses instance colors");
    }
    const previous = ti._lodPartner;
    if (previous && previous !== lodMesh) {
        const prevTi = previous.thinInstances;
        if (prevTi && prevTi._lodSource === fullMesh) {
            releaseLodConsumer(prevTi);
        }
        previous._clone = undefined;
        ti._lodBuckets = null;
    }
    ti._lodPartner = lodMesh;
    ti._lodDistance = options.distance;
    ti._lodBand = band;
    lodTi._lodSource = fullMesh;
    fullMesh._clone = lodMesh._clone = "Cannot clone LOD-paired mesh";
    const buckets = ti._lodBuckets ?? new WeakMap<RenderTargetSignature, ThinInstanceLodBucket>();
    ti._lodBuckets = buckets;
    lodTi._lodBuckets = buckets;
    if (!lodTi._gpuCullingEnabled) {
        // Route the partner through the culling draw path (so it can consume the far bucket and skip
        // its own count) and make sure the cull module is fetched for its material group.
        lodTi._lodAutoCull = true;
        lodTi._gpuCullingEnabled = true;
        lodTi._gpuVersion = -1;
        lodTi._colorGpuVersion = -1;
    }
}

/** Dissolve a `setThinInstanceLodPartner` pairing: `fullMesh` culling reverts to its single-bucket output and
 * the former partner returns to independent rendering (drawing its own instance count again after the next
 * renderable rebuild; GPU culling auto-enabled by the pairing is switched back off). */
export function clearThinInstanceLodPartner(fullMesh: Mesh): void {
    const ti = fullMesh.thinInstances;
    if (!ti?._lodPartner) {
        return;
    }
    const lodMesh = ti._lodPartner;
    const lodTi = lodMesh.thinInstances;
    ti._lodPartner = null;
    ti._lodDistance = undefined;
    ti._lodBand = undefined;
    ti._lodBuckets = null;
    fullMesh._clone = undefined;
    lodMesh._clone = undefined;
    if (lodTi && lodTi._lodSource === fullMesh) {
        releaseLodConsumer(lodTi);
    }
}

/** @internal Break any incoming or outgoing LOD pairing before a mesh's GPU resources are disposed. */
export function _detachThinInstanceLodMesh(mesh: Mesh): void {
    const ti = mesh.thinInstances;
    if (!ti) {
        return;
    }
    const source = ti._lodSource;
    const sourceTi = source?.thinInstances;
    if (source && sourceTi?._lodPartner === mesh) {
        sourceTi._lodPartner = null;
        sourceTi._lodDistance = undefined;
        sourceTi._lodBand = undefined;
        sourceTi._lodBuckets = null;
        source._clone = undefined;
    }
    if (ti._lodSource) {
        releaseLodConsumer(ti);
    }
    const partner = ti._lodPartner;
    const partnerTi = partner?.thinInstances;
    ti._lodPartner = null;
    ti._lodDistance = undefined;
    ti._lodBand = undefined;
    ti._lodBuckets = null;
    mesh._clone = undefined;
    if (partner && partnerTi?._lodSource === mesh) {
        partner._clone = undefined;
        releaseLodConsumer(partnerTi);
    }
}

function releaseLodConsumer(lodTi: ThinInstanceData): void {
    lodTi._lodSource = null;
    lodTi._lodBuckets = null;
    if (lodTi._lodAutoCull) {
        lodTi._lodAutoCull = false;
        lodTi._gpuCullingEnabled = false;
        lodTi._gpuVersion = -1;
        lodTi._colorGpuVersion = -1;
    }
}
