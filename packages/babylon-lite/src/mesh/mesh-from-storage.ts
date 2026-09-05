/**
 * Module: mesh-from-storage
 *
 * Geometry that lives only on the GPU. A mesh created here sources its vertex
 * stream directly from a `StorageBuffer` — so a compute pass can produce vertices
 * and the draw can consume them in place, with **no readback and no copy**.
 *
 * This is the seam that procedural/GPU-generated worlds need. Lite's canonical
 * path (`createMeshFromData`) takes CPU `Float32Array`s and uploads them, which
 * forces GPU-produced geometry through a device→host→device round trip.
 *
 * Zero-cost when unused: nothing in the core render path imports this module, so
 * it tree-shakes away entirely for scenes that never call the factory.
 *
 * Usage contract:
 *  - The allocation must come from `createStorageBuffer(..., { writable: true, vertex: true })`.
 *  - The PACKING is described here, by `arrayStride` + `attributeOffsets`, and is carried
 *    on the mesh as `MeshGPU._vbLayout` — the same record the glTF interleave path
 *    produces. The material only declares the FORMAT its shader reads
 *    (`ShaderMaterialOptions.attributeFormats`), so one material can draw both these
 *    meshes and ordinary tightly-packed ones.
 *  - Bounds are the caller's responsibility: the CPU never sees these vertices, so
 *    `boundMin`/`boundMax` must be supplied (analytically, or from a known envelope)
 *    for frustum culling to stay correct.
 *  - CPU-side picking (`_cpuPositions`) is unavailable by construction.
 */
import type { EngineContext } from "../engine/engine.js";
import type { Mesh, MeshGPU, MeshVbLayout } from "./mesh.js";
import { initMeshTransform } from "./mesh.js";
import { BU } from "../engine/gpu-flags.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { _getStorageBufferHandle, _installStorageRebuildObserver, type StorageBuffer } from "../resource/storage-buffer.js";
import type { ShaderAttributeName } from "../material/shader/shader-material.js";
import { _enableShaderVb } from "../material/shader/shader-vb.js";
import { _installBorrowAwareGeometryDisposer } from "./mesh-dispose.js";

/** Describes a mesh whose vertices are produced on the GPU. */
export interface MeshFromStorageOptions {
    /** Vertex source. Must be `writable: true, vertex: true`. */
    readonly storage: StorageBuffer;
    /** Triangle indices.
     *
     *  A `Uint32Array` is uploaded into a fresh index buffer owned by this mesh —
     *  right when the mesh has topology of its own.
     *
     *  A `StorageBuffer` created with `{ index: true }` is used in place, SHARED with
     *  every other mesh given the same allocation. That is the right form for a slab of
     *  uniform slots, where every slot's indices are byte-identical and uploading them
     *  per mesh would duplicate the same kilobytes thousands of times. A shared
     *  allocation is NOT freed with the mesh; it outlives the meshes and the caller
     *  disposes it. */
    readonly indices: Uint16Array | Uint32Array | StorageBuffer;
    /** Index format. Derived from the typed array's element size when `indices` is one;
     *  REQUIRED when `indices` is a shared allocation, whose element size is not recoverable
     *  from the allocation. A 16-bit topology declared as 32-bit fails WebGPU validation with
     *  a size complaint that points at the buffer rather than at the format. */
    readonly indexFormat?: GPUIndexFormat;
    /** Number of indices to draw. Required when `indices` is a shared allocation, since
     *  its byte length is padded and need not equal the draw count. Defaults to the
     *  typed array's length. */
    readonly indexCount?: number;
    /** Number of vertices addressed by `indices`, used for validation only. */
    readonly vertexCount: number;
    /** Byte stride of one vertex inside `storage`. Must match what the compute shader writes. */
    readonly arrayStride: number;
    /** Byte offset of each attribute inside one vertex. Omitted attributes sit at offset 0,
     *  which is the right default when a single `float32x4` position is the whole vertex.
     *
     *  Only the six streams `MeshVbLayout` describes can be offset (position, normal,
     *  tangent, uv, uv2, color); skinning attributes are not supported from a slab. */
    readonly attributeOffsets?: Partial<Record<ShaderAttributeName, number>>;
    /** First vertex of this mesh within a shared allocation.
     *
     *  This is how many meshes share ONE slab: each takes a slot and addresses it
     *  through the draw call's `baseVertex`, rather than a non-zero `setVertexBuffer`
     *  bind offset (which corrupts vertex fetch on some AMD/Dawn paths). Default 0. */
    readonly baseVertex?: number;
    /** Analytic lower bound of the produced geometry, in mesh-local space. */
    readonly boundMin?: readonly [number, number, number];
    /** Analytic upper bound of the produced geometry, in mesh-local space. */
    readonly boundMax?: readonly [number, number, number];
}

/** Create a mesh that draws straight from a GPU storage allocation. */
export function createMeshFromStorageBuffer(engine: EngineContext, name: string, options: MeshFromStorageOptions): Mesh {
    const { storage, indices, vertexCount, arrayStride, baseVertex = 0 } = options;

    if ((storage._usage & BU.VERTEX) === 0) {
        throw new Error("createMeshFromStorageBuffer: storage must be created with { vertex: true } so it carries GPUBufferUsage.VERTEX.");
    }
    if (!Number.isInteger(arrayStride) || arrayStride <= 0 || arrayStride % 4 !== 0) {
        throw new Error(`createMeshFromStorageBuffer: arrayStride must be a positive multiple of 4, received ${arrayStride}.`);
    }
    const required = (baseVertex + vertexCount) * arrayStride;
    if (required > storage.byteLength) {
        throw new Error(`createMeshFromStorageBuffer: slot needs ${required} bytes but the allocation is ${storage.byteLength} bytes.`);
    }

    const vertexBuffer = _getStorageBufferHandle(engine, storage);
    const sharedIndices = !ArrayBuffer.isView(indices);
    if (sharedIndices && ((indices as StorageBuffer)._usage & BU.INDEX) === 0) {
        throw new Error("createMeshFromStorageBuffer: a StorageBuffer passed as `indices` must be created with { index: true } so it carries GPUBufferUsage.INDEX.");
    }
    const indexCount = options.indexCount ?? (sharedIndices ? 0 : (indices as Uint16Array | Uint32Array).length);
    if (indexCount <= 0) {
        throw new Error(
            "createMeshFromStorageBuffer: `indexCount` is required when `indices` is a shared allocation (its byte length is padded and need not equal the draw count)."
        );
    }
    const indexFormat: GPUIndexFormat = options.indexFormat ?? (sharedIndices ? "uint32" : (indices as Uint16Array | Uint32Array).BYTES_PER_ELEMENT === 2 ? "uint16" : "uint32");
    if (sharedIndices && !options.indexFormat) {
        throw new Error("createMeshFromStorageBuffer: `indexFormat` is required when `indices` is a shared allocation — its element size cannot be recovered from the allocation.");
    }
    const indexBuffer = sharedIndices
        ? _getStorageBufferHandle(engine, indices as StorageBuffer)
        : createMappedBuffer(engine, indices as Uint16Array | Uint32Array, BU.INDEX, `${name}-indices`);

    const offsets = options.attributeOffsets;
    const vbLayout: MeshVbLayout = {
        _p: { _stride: arrayStride, _offset: offsets?.position ?? 0 },
        _n: { _stride: arrayStride, _offset: offsets?.normal ?? 0 },
        _t: { _stride: arrayStride, _offset: offsets?.tangent ?? 0 },
        _u: { _stride: arrayStride, _offset: offsets?.uv ?? 0 },
        _u2: { _stride: arrayStride, _offset: offsets?.uv2 ?? 0 },
        _c: { _stride: arrayStride, _offset: offsets?.color ?? 0 },
    };

    installHooks();

    const mesh = initMeshTransform({
        name,
        material: null as unknown as Mesh["material"],
        receiveShadows: false,
        boundMin: options.boundMin ? [...options.boundMin] : undefined,
        boundMax: options.boundMax ? [...options.boundMax] : undefined,
        _gpu: {
            // Every attribute reads the one shared allocation; `_vbLayout` splits it into
            // fields via stride + offset, exactly as an interleaved glTF mesh does.
            positionBuffer: vertexBuffer,
            normalBuffer: vertexBuffer,
            uvBuffer: vertexBuffer,
            indexBuffer,
            indexCount,
            indexFormat,
            _baseVertex: baseVertex,
            _vbLayout: vbLayout,
            // Distinct from the loader's `vb…` keys, so a slab mesh and an interleaved glTF
            // mesh can never collide on one material's pipeline cache.
            _vbKey: `sb${arrayStride}.${vbLayout._p!._offset}.${vbLayout._n!._offset}.${vbLayout._t!._offset}.${vbLayout._u!._offset}.${vbLayout._u2!._offset}.${vbLayout._c!._offset}`,
            // The slab belongs to whoever created it and is shared with every other
            // mesh holding a slot; this mesh only borrows it.
            _ownsVertexBuffers: false,
            _ownsIndexBuffer: !sharedIndices,
        },
    });

    (_slabSources ??= new WeakMap()).set(mesh._gpu, { _vb: storage, _ib: sharedIndices ? (indices as StorageBuffer) : null });
    (_slabMeshes ??= new Set()).add(new WeakRef(mesh._gpu));

    return mesh;
}

/** Meshes that borrow a slab, so their cached `GPUBuffer` handles can be re-pointed after
 *  a device-loss rebuild replaces the underlying allocations.
 *
 *  Held through `WeakRef`, matching `device-lost-recovery-capture.ts`: a strong registry
 *  would keep a `MeshGPU` and two `GPUBuffer`s alive for the page's lifetime whenever a
 *  mesh is dropped without going through `disposeMeshGpu`, which is a leak this module
 *  would be introducing. Dead refs are pruned on each rebuild, so nothing has to be
 *  unregistered on the dispose path and no per-disposal scan is needed.
 *
 *  Lazily created -- GUIDANCE.md forbids module-level allocations. */
interface SlabSources {
    readonly _vb: StorageBuffer;
    readonly _ib: StorageBuffer | null;
}
/** The weak ref must target the MESH's own `_gpu`, which the mesh holds strongly -- a ref
 *  to a wrapper object created here would have no other owner and collect immediately,
 *  leaving the registry silently empty. The allocations hang off a WeakMap so they do not
 *  keep the geometry alive either. */
let _slabMeshes: Set<WeakRef<MeshGPU>> | null = null;
let _slabSources: WeakMap<MeshGPU, SlabSources> | null = null;

/** Re-point every borrowed handle at its allocation's current buffer. The allocations have
 *  already been rebuilt when this runs; the meshes are still holding the dead handles. */
function refreshSlabMeshes(engine: EngineContext): void {
    for (const ref of _slabMeshes ?? []) {
        const gpu = ref.deref();
        const entry = gpu ? _slabSources?.get(gpu) : undefined;
        if (!entry) {
            _slabMeshes!.delete(ref);
            continue;
        }
        // The registry is module-global but a page may run several engines; only this
        // engine's allocations have been rebuilt, and resolving another's would throw.
        if (entry._vb._engine !== engine) {
            continue;
        }
        // An allocation disposed while a borrowing mesh is still alive would make
        // `_getStorageBufferHandle` throw, and this runs inside a recovery step -- a throw
        // here aborts the WHOLE device-loss recovery, taking every unrelated scene with it.
        // A mesh borrowing a dead slab is already unusable; skip it rather than fail.
        if (entry._vb._destroyed || entry._ib?._destroyed) {
            continue;
        }
        const g = gpu as unknown as { positionBuffer: GPUBuffer; normalBuffer: GPUBuffer; uvBuffer: GPUBuffer; indexBuffer: GPUBuffer };
        const vb = _getStorageBufferHandle(engine, entry._vb);
        g.positionBuffer = vb;
        g.normalBuffer = vb;
        g.uvBuffer = vb;
        if (entry._ib) {
            g.indexBuffer = _getStorageBufferHandle(engine, entry._ib);
        }
    }
}

let _hooksInstalled = false;

/** Teach the shared mesh and ShaderMaterial paths about GPU-resident geometry: declared
 *  attribute formats, per-mesh packing, slot-based draws, and borrowed buffers. Called on
 *  first use of this factory, so a bundle without it leaves every hook null and folds those
 *  branches away. */
function installHooks(): void {
    if (_hooksInstalled) {
        return;
    }
    _hooksInstalled = true;
    _enableShaderVb();
    _installBorrowAwareGeometryDisposer((g) => {
        // Buffers may be BORROWED rather than owned. A mesh whose vertices live in a shared
        // GPU-resident slab points every vertex-side field at that one allocation, so
        // destroying them here would tear the slab out from under every other mesh holding a
        // slot in it — and the same for a shared index topology.
        if (g._ownsVertexBuffers !== false) {
            g.positionBuffer.destroy();
            g.normalBuffer.destroy();
            g.uvBuffer.destroy();
            g.tangentBuffer?.destroy();
            g.uv2Buffer?.destroy();
            g.colorBuffer?.destroy();
        }
        if (g._ownsIndexBuffer !== false) {
            g.indexBuffer.destroy();
        }
    });
    _installStorageRebuildObserver(refreshSlabMeshes);
}
