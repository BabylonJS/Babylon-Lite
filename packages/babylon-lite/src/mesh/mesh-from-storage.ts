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
 *    (`setShaderAttributeFormats`), so one material can draw meshes with matching
 *    formats even when their byte packing differs.
 *  - Bounds are the caller's responsibility: the CPU never sees these vertices, so
 *    `boundMin`/`boundMax` must be supplied (analytically, or from a known envelope)
 *    for frustum culling to stay correct.
 *  - CPU-side picking (`_cpuPositions`) is unavailable by construction.
 */
import type { EngineContext } from "../engine/engine.js";
import type { Mesh, MeshVbAttr, MeshVbLayout } from "./mesh.js";
import { initMeshTransform } from "./mesh.js";
import { BU } from "../engine/gpu-flags.js";
import { createMappedBuffer } from "../resource/mapped-buffer.js";
import { _getStorageBufferHandle, type StorageBuffer } from "../resource/storage-buffer.js";
import { _enableShaderVb } from "../material/shader/shader-vb.js";
import { _installBorrowAwareGeometryDisposer } from "./mesh-dispose.js";
import { _enableVertexDefaults } from "./vertex-defaults.js";
import { createMeshVertexLayout } from "./mesh-vertex-layout.js";

const ZERO_LAYOUT: MeshVbAttr = { _stride: 0, _offset: 0 };

/** Describes a mesh whose vertices are produced on the GPU. */
export interface MeshFromStorageOptions {
    /** Vertex source. Must be `vertex: true`; GPU-written sources also require `writable: true`. */
    readonly storage: StorageBuffer;
    /** Triangle indices.
     *
     *  A `Uint16Array` or `Uint32Array` is snapshotted and uploaded into a fresh index
     *  buffer owned by this mesh. The used prefix is validated for the initial upload;
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
    /** Byte stride of one vertex inside `storage`. A positive multiple of four within the device's vertex-stride limit. */
    readonly arrayStride: number;
    /** Own-property byte offsets inside one vertex. Values must be non-negative integers smaller than `arrayStride`.
     *  Omitted position, normal, and UV attributes sit at offset 0,
     *  which is the right default when a single `float32x4` position is the whole vertex.
     *
     *  Only the six streams `MeshVbLayout` describes can be offset (position, normal,
     *  tangent, uv, uv2, color); skinning attributes are not supported from a slab. */
    readonly attributeOffsets?: Partial<Record<"position" | "normal" | "tangent" | "uv" | "uv2" | "color", number>>;
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
    const { storage, indices, vertexCount, arrayStride, attributeOffsets, baseVertex = 0 } = options;

    if ((storage._usage & BU.VERTEX) === 0) {
        throw new Error("createMeshFromStorageBuffer: storage must be created with { vertex: true } so it carries GPUBufferUsage.VERTEX.");
    }
    if (arrayStride !== (arrayStride | 0) || arrayStride <= 0 || arrayStride % 4 !== 0 || arrayStride > engine._device.limits.maxVertexBufferArrayStride) {
        throw new Error(`createMeshFromStorageBuffer: arrayStride must be a positive multiple of 4 within maxVertexBufferArrayStride, received ${arrayStride}.`);
    }
    const required = (baseVertex + vertexCount) * arrayStride;
    if (vertexCount !== (vertexCount | 0) || vertexCount <= 0 || baseVertex !== (baseVertex | 0) || baseVertex < 0 || required > storage.byteLength) {
        throw new Error(`createMeshFromStorageBuffer: invalid vertex range (${vertexCount} vertices at baseVertex ${baseVertex}) for a ${storage.byteLength}-byte allocation.`);
    }

    const defaultSlabLayout: MeshVbAttr = { _stride: arrayStride, _offset: 0 };
    const streams = createMeshVertexLayout({
        position: defaultSlabLayout,
        normal: defaultSlabLayout,
        uv: defaultSlabLayout,
        tangent: ZERO_LAYOUT,
        uv2: ZERO_LAYOUT,
        color: ZERO_LAYOUT,
    });
    if (attributeOffsets) {
        for (const name of Object.keys(attributeOffsets)) {
            if (!(streams as MeshVbLayout)[name]) {
                throw new Error(`createMeshFromStorageBuffer: unsupported attribute offset "${name}".`);
            }
            const key = name as keyof typeof streams;
            const offset = attributeOffsets[key];
            if (offset === undefined) {
                continue;
            }
            if (!Number.isInteger(offset) || offset < 0 || offset >= arrayStride) {
                throw new Error(`createMeshFromStorageBuffer: offset for "${name}" must be a non-negative integer smaller than arrayStride.`);
            }
            streams[key] = { _stride: arrayStride, _offset: offset };
        }
    }
    const slabTangent = streams.tangent._stride !== 0;
    const slabUv2 = streams.uv2._stride !== 0;
    const slabColor = streams.color._stride !== 0;

    const indexSource = validateIndexSource(indices, options.indexFormat, options.indexCount, vertexCount);
    const vertexBuffer = _getStorageBufferHandle(engine, storage);
    const ownsIndexBuffer = ArrayBuffer.isView(indexSource.data);
    const indexBuffer = ownsIndexBuffer ? createMappedBuffer(engine, indexSource.data, BU.INDEX, `${name}-indices`) : _getStorageBufferHandle(engine, indexSource.data);

    _enableVertexDefaults(engine);
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
            _vbLayout: streams,
            // Distinct from the loader's `vb…` keys, so a slab mesh and an interleaved glTF
            // mesh can never collide on one material's pipeline cache.
            _vbKey: `sb${arrayStride}.${streams.position._offset}.${streams.normal._offset}.${streams.uv._offset}.${slabTangent ? streams.tangent._offset : "-"}.${slabUv2 ? streams.uv2._offset : "-"}.${slabColor ? streams.color._offset : "-"}`,
            // The slab belongs to whoever created it and is shared with every other
            // mesh holding a slot; this mesh only borrows it.
            _ownsVertexBuffers: false,
            _ownsIndexBuffer: ownsIndexBuffer,
        },
    });

    return mesh;
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
    const capacity = typed ? indices.length : indices.byteLength / (format === "uint16" ? 2 : 4);
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
    _installBorrowAwareGeometryDisposer((g, disposeVertices) => {
        // Buffers may be BORROWED rather than owned. A mesh whose vertices live in a shared
        // GPU-resident slab points every vertex-side field at that one allocation, so
        // destroying them here would tear the slab out from under every other mesh holding a
        // slot in it — and the same for a shared index topology.
        if (g._ownsVertexBuffers !== false) {
            disposeVertices(g);
        }
        if (g._ownsIndexBuffer !== false) {
            g.indexBuffer.destroy();
        }
    });
}
