/**
 * Module: mesh-from-storage
 *
 * Geometry that lives only on the GPU. A mesh created here sources its vertex
 * stream directly from a `StorageBuffer`, so whoever fills that allocation — the CPU,
 * or eventually a compute pass — produces vertices the draw consumes in place, with
 * **no readback and no copy**.
 *
 * This is the seam that procedural/GPU-generated worlds need. Lite's canonical
 * path (`createMeshFromData`) takes CPU `Float32Array`s and uploads them, which
 * forces GPU-produced geometry through a device→host→device round trip.
 *
 * Zero-cost when unused: nothing in the core render path imports this module, so
 * it tree-shakes away entirely for scenes that never call the factory.
 *
 * Usage contract:
 *  - The allocation must come from `createStorageBuffer(..., { vertex: true })`.
 *    Also request `writable: true` when a GPU shader produces its contents.
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
import { createMappedBuffer } from "../resource/mapped-buffer.js";
import { _getStorageBufferHandle, _installStorageRebuildObserver, type StorageBuffer } from "../resource/storage-buffer.js";
import type { ShaderAttributeName } from "../material/shader/shader-material.js";
import { _enableShaderVb } from "../material/shader/shader-vb.js";
import { _installBorrowAwareGeometryDisposer } from "./mesh-dispose.js";
import { _enableVertexDefaults } from "./vertex-defaults.js";

/** Describes a mesh whose vertices are produced on the GPU. */
export interface MeshFromStorageOptions {
    /** Vertex source. Must be `vertex: true`; GPU-written sources also require `writable: true`. */
    readonly storage: StorageBuffer;
    /** Triangle indices.
     *
     *  A `Uint16Array` or `Uint32Array` is snapshotted and uploaded into a fresh index
     *  buffer owned by this mesh. The used prefix is retained for device recovery;
     *  later changes to the caller's array do not change the uploaded topology.
     *
     *  A `StorageBuffer` created with `{ index: true }` is used in place, SHARED with
     *  every other mesh given the same allocation. That is the right form for a slab of
     *  uniform slots, where every slot's indices are byte-identical and uploading them
     *  per mesh would duplicate the same kilobytes thousands of times. A shared
     *  allocation is NOT freed with the mesh; it outlives the meshes and the caller
     *  disposes it. */
    readonly indices: Uint16Array | Uint32Array | StorageBuffer;
    /** Index format. Derived from the typed array's element size when `indices` is one
     *  (an explicit format must match);
     *  REQUIRED when `indices` is a shared allocation, whose element size is not recoverable
     *  from the allocation. A 16-bit topology declared as 32-bit fails WebGPU validation with
     *  a size complaint that points at the buffer rather than at the format. */
    readonly indexFormat?: GPUIndexFormat;
    /** Number of indices to draw. Required when `indices` is a shared allocation, since
     *  its byte length is padded and need not equal the draw count. Defaults to the
     *  typed array's length. Must be a positive integer within the source capacity.
     *  Every used typed-array index must be less than `vertexCount`. */
    readonly indexCount?: number;
    /** Logical vertex count in this mesh's slot, used for range validation and missing-stream defaults. */
    readonly vertexCount: number;
    /** Byte stride of one vertex inside `storage`. Must match the packing whatever wrote it used. */
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
    if (arrayStride !== (arrayStride | 0) || arrayStride <= 0 || arrayStride % 4 !== 0) {
        throw new Error(`createMeshFromStorageBuffer: arrayStride must be a positive multiple of 4, received ${arrayStride}.`);
    }
    const required = (baseVertex + vertexCount) * arrayStride;
    if (vertexCount !== (vertexCount | 0) || vertexCount <= 0 || baseVertex !== (baseVertex | 0) || baseVertex < 0 || required > storage.byteLength) {
        throw new Error(`createMeshFromStorageBuffer: invalid vertex range (${vertexCount} vertices at baseVertex ${baseVertex}) for a ${storage.byteLength}-byte allocation.`);
    }

    const indexSource = validateIndexSource(indices, options.indexFormat, options.indexCount, vertexCount);
    const vertexBuffer = _getStorageBufferHandle(engine, storage);
    const indexLabel = `${name}-indices`;
    const indexBuffer = resolveIndexBuffer(engine, indexSource.data, indexLabel);

    const offsets = options.attributeOffsets;
    // Only streams that actually READ from the slab get a layout entry. Recording one for
    // an attribute whose buffer is a tiny zero fallback hands the pipeline the slab's
    // stride against a buffer far too small for it: wrong reads at best, a buffer-size
    // validation failure at worst. position/normal/uv always point at the slab, so they
    // are always described; the optional three are described only when the caller asked
    // for them, which is also when they are wired up below.
    const slabTangent = offsets?.tangent !== undefined;
    const slabUv2 = offsets?.uv2 !== undefined;
    const slabColor = offsets?.color !== undefined;
    const vbLayout: MeshVbLayout = {
        _p: { _stride: arrayStride, _offset: offsets?.position ?? 0 },
        _n: { _stride: arrayStride, _offset: offsets?.normal ?? 0 },
        _u: { _stride: arrayStride, _offset: offsets?.uv ?? 0 },
        ...(slabTangent ? { _t: { _stride: arrayStride, _offset: offsets!.tangent! } } : {}),
        ...(slabUv2 ? { _u2: { _stride: arrayStride, _offset: offsets!.uv2! } } : {}),
        ...(slabColor ? { _c: { _stride: arrayStride, _offset: offsets!.color! } } : {}),
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
            hasUv: true,
            // Advertised by `attributeOffsets`, so they have to come from the slab too.
            tangentBuffer: slabTangent ? vertexBuffer : null,
            uv2Buffer: slabUv2 ? vertexBuffer : null,
            colorBuffer: slabColor ? vertexBuffer : null,
            hasUv2: slabUv2,
            hasTangent: slabTangent,
            hasColor: slabColor,
            indexBuffer,
            indexCount: indexSource.count,
            indexFormat: indexSource.format,
            _baseVertex: baseVertex,
            _vertexCount: vertexCount,
            _vbLayout: vbLayout,
            // Distinct from the loader's `vb…` keys, so a slab mesh and an interleaved glTF
            // mesh can never collide on one material's pipeline cache.
            _vbKey: `sb${arrayStride}.${vbLayout._p!._offset}.${vbLayout._n!._offset}.${vbLayout._u!._offset}.${vbLayout._t?._offset ?? "-"}.${vbLayout._u2?._offset ?? "-"}.${vbLayout._c?._offset ?? "-"}`,
            // The slab belongs to whoever created it and is shared with every other
            // mesh holding a slot; this mesh only borrows it.
            _ownsVertexBuffers: false,
            _ownsIndexBuffer: ArrayBuffer.isView(indexSource.data),
        },
    });

    const source: SlabSources = {
        _vb: storage,
        _indices: indexSource,
        _indexLabel: indexLabel,
        _device: engine._device,
        _registration: new WeakRef(mesh._gpu),
    };
    (_slabSources ??= new WeakMap()).set(mesh._gpu, source);
    (_slabMeshes ??= new Set()).add(source._registration);

    return mesh;
}

/** Meshes that borrow a slab, so their cached `GPUBuffer` handles can be re-pointed after
 *  a device-loss rebuild replaces the underlying allocations.
 *
 *  Held through `WeakRef`, matching `device-lost-recovery-capture.ts`: a strong registry
 *  would keep a `MeshGPU` and two `GPUBuffer`s alive for the page's lifetime whenever a
 *  mesh is dropped without going through `disposeMeshGpu`, which is a leak this module
 *  would be introducing. Final release removes its exact registration token in O(1);
 *  abandoned dead refs are also pruned on rebuild.
 *
 *  Lazily created -- GUIDANCE.md forbids module-level allocations. */
interface SlabSources {
    readonly _vb: StorageBuffer;
    readonly _indices: SlabIndexSource;
    readonly _indexLabel: string;
    readonly _registration: WeakRef<MeshGPU>;
    _device: GPUDevice;
}

interface SlabIndexSource {
    readonly data: Uint16Array | Uint32Array | StorageBuffer;
    readonly count: number;
    readonly format: GPUIndexFormat;
}

function validateIndexSource(indices: MeshFromStorageOptions["indices"], format: GPUIndexFormat | undefined, count: number | undefined, vertexCount: number): SlabIndexSource {
    const typed = ArrayBuffer.isView(indices);
    if (typed) {
        if (!(indices instanceof Uint16Array || indices instanceof Uint32Array)) {
            throw new Error("createMeshFromStorageBuffer: indices must be a Uint16Array, Uint32Array, or index-capable StorageBuffer.");
        }
        const inferred = indices.BYTES_PER_ELEMENT === 2 ? "uint16" : "uint32";
        if (format !== undefined && format !== inferred) {
            throw new Error(`createMeshFromStorageBuffer: indexFormat must match the typed-array format "${inferred}".`);
        }
        format = inferred;
        count ??= indices.length;
    } else {
        if ((indices._usage & BU.INDEX) === 0) {
            throw new Error("createMeshFromStorageBuffer: indices must be created with { index: true }.");
        }
        if (format !== "uint16" && format !== "uint32") {
            throw new Error('createMeshFromStorageBuffer: a shared index allocation requires indexFormat "uint16" or "uint32".');
        }
    }
    if (count === undefined || !Number.isInteger(count) || count <= 0 || count > 0xffffffff) {
        throw new Error("createMeshFromStorageBuffer: indexCount must be a positive unsigned 32-bit integer.");
    }
    const capacity = typed ? indices.length : Math.floor(indices.byteLength / (format === "uint16" ? 2 : 4));
    if (count > capacity) {
        throw new Error(`createMeshFromStorageBuffer: indexCount ${count} exceeds the index source capacity of ${capacity}.`);
    }
    if (typed) {
        for (let index = 0; index < count; index++) {
            if (indices[index]! >= vertexCount) {
                throw new Error(`createMeshFromStorageBuffer: indices[${index}] (${indices[index]}) must be less than vertexCount ${vertexCount}.`);
            }
        }
    }
    return { data: typed ? indices.slice(0, count) : indices, count, format };
}

function resolveIndexBuffer(engine: EngineContext, data: SlabIndexSource["data"], label: string): GPUBuffer {
    return ArrayBuffer.isView(data) ? createMappedBuffer(engine, data, BU.INDEX, label) : _getStorageBufferHandle(engine, data);
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
        if (!gpu || !entry) {
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
        const indexData = entry._indices.data;
        const ownedIndices = ArrayBuffer.isView(indexData);
        if (entry._vb._destroyed || (!ownedIndices && indexData._destroyed)) {
            continue;
        }
        const g = gpu as unknown as Record<"positionBuffer" | "normalBuffer" | "tangentBuffer" | "uvBuffer" | "uv2Buffer" | "colorBuffer" | "indexBuffer", GPUBuffer | null>;
        const vb = _getStorageBufferHandle(engine, entry._vb);
        const replaceIndex = !ownedIndices || entry._device !== engine._device;
        const indexBuffer = replaceIndex ? resolveIndexBuffer(engine, indexData, entry._indexLabel) : gpu.indexBuffer;
        if (ownedIndices && replaceIndex) {
            gpu.indexBuffer.destroy();
        }
        g.positionBuffer = vb;
        g.normalBuffer = vb;
        g.uvBuffer = vb;
        for (const stream of ["tangentBuffer", "uv2Buffer", "colorBuffer"] as const) {
            if (g[stream]) {
                g[stream] = vb;
            }
        }
        g.indexBuffer = indexBuffer;
        entry._device = engine._device;
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
    _enableVertexDefaults();
    _enableShaderVb();
    _installBorrowAwareGeometryDisposer((g) => {
        const source = _slabSources?.get(g);
        if (source) {
            _slabMeshes?.delete(source._registration);
        }
        _slabSources?.delete(g);
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
