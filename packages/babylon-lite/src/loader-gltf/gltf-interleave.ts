/**
 * Interleaved (strided) glTF vertex-buffer support — dynamically imported.
 *
 * The engine renders interleaved attributes genuinely: the raw strided
 * bufferView slice is uploaded ONCE as a shared GPU buffer and bound to each
 * attribute at its byte offset with the pipeline's vertex `arrayStride` set to
 * the bufferView byteStride. The loader never rewrites the asset.
 *
 * This whole module is loaded via `await import()` only when an asset actually
 * contains an interleaved bufferView, so non-interleaved scenes pay ZERO bundle
 * cost. The tight CPU copy of position/normal/uv (for AABB, picking, CSG, …) is
 * de-strided LAZILY — only on first CPU read via `installLazyCpu` — so scenes
 * that only render never materialize it.
 */

import type { Mat4 } from "../math/types.js";
import type { Aabb } from "../math/aabb.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { resolveAccessor, TYPE_SIZES } from "./gltf-parser.js";
import type { GltfMeshData } from "./load-gltf.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;

const COMP_BYTES: Record<number, number> = { [UNSIGNED_BYTE]: 1, [UNSIGNED_SHORT]: 2, [UNSIGNED_INT]: 4, [FLOAT]: 4 };

/** Interleave descriptor for one attribute sourced from a strided bufferView.
 *  The raw slice is shared across attributes of the same bufferView; the
 *  pipeline uses `_stride` as arrayStride and binds at `_offset`. */
export interface AccessorInterleave {
    /** @internal glTF bufferView index — shared-buffer key (same view → one GPU buffer). */
    _bufferView: number;
    /** @internal Interleave byte stride (bufferView.byteStride) → pipeline arrayStride. */
    _stride: number;
    /** @internal Attribute byte offset within the bufferView → setVertexBuffer bind offset. */
    _offset: number;
    /** @internal glTF component type (FLOAT, UNSIGNED_SHORT, …). */
    _componentType: number;
    /** @internal Components per vertex. */
    _componentCount: number;
    /** @internal Vertex count. */
    _count: number;
    /** @internal Raw bufferView bytes (shared across attributes). Retained after GPU upload
     *  so the CPU copy can be de-strided lazily on demand. */
    _slice?: Uint8Array;
}

/** Per-attribute interleave sources for a primitive (keys mirror MeshVbLayout). */
export interface GltfVb {
    /** @internal */
    _p?: AccessorInterleave;
    /** @internal */
    _n?: AccessorInterleave;
    /** @internal */
    _t?: AccessorInterleave;
    /** @internal */
    _u?: AccessorInterleave;
    /** @internal */
    _u2?: AccessorInterleave;
    /** @internal */
    _c?: AccessorInterleave;
}

/** True if accessor `idx`'s bufferView is interleaved (byteStride present and
 *  larger than the attribute's tightly-packed element size). */
export function accessorIsStrided(json: any, idx: number): boolean {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const stride: number | undefined = bv.byteStride;
    if (stride === undefined) {
        return false;
    }
    const elemBytes = (TYPE_SIZES[a.type] ?? 1) * (COMP_BYTES[a.componentType] ?? 4);
    return stride !== elemBytes;
}

/** Resolve a strided accessor into an {@link AccessorInterleave} descriptor. */
function resolveStrided(json: any, binChunk: DataView, accessorIdx: number): AccessorInterleave {
    const accessor = json.accessors[accessorIdx];
    const bufferView = json.bufferViews[accessor.bufferView];
    const ab = binChunk.buffer as ArrayBuffer;
    return {
        _bufferView: accessor.bufferView,
        _stride: bufferView.byteStride,
        _offset: accessor.byteOffset ?? 0,
        _componentType: accessor.componentType,
        _componentCount: TYPE_SIZES[accessor.type] ?? 1,
        _count: accessor.count,
        _slice: new Uint8Array(ab, binChunk.byteOffset + (bufferView.byteOffset ?? 0), bufferView.byteLength),
    };
}

/** De-stride an interleaved attribute into a tight Float32Array, reading raw
 *  component values (no normalization) so the result matches what a tight
 *  accessor view would have produced. */
function destrideToTight(il: AccessorInterleave): Float32Array {
    const dv = new DataView(il._slice!.buffer, il._slice!.byteOffset, il._slice!.byteLength);
    const cb = COMP_BYTES[il._componentType] ?? 4;
    const ct = il._componentType;
    const cc = il._componentCount;
    const out = new Float32Array(il._count * cc);
    for (let v = 0; v < il._count; v++) {
        const rowBase = il._offset + v * il._stride;
        for (let c = 0; c < cc; c++) {
            const off = rowBase + c * cb;
            out[v * cc + c] =
                ct === FLOAT ? dv.getFloat32(off, true) : ct === UNSIGNED_SHORT ? dv.getUint16(off, true) : ct === UNSIGNED_INT ? dv.getUint32(off, true) : dv.getUint8(off);
        }
    }
    return out;
}

/** Build a mesh-data partial for a primitive, but ONLY if it actually sources
 *  ≥1 attribute from an interleaved (strided) bufferView. Returns `undefined`
 *  for fully-tight primitives so the caller falls back to its tight path.
 *
 *  Strided POSITION/NORMAL/TEXCOORD_0 attributes keep their raw slice in `_vb`
 *  (for genuine GPU interleaving) and leave the tight CPU field `null` — the
 *  de-strided copy is materialized lazily on first CPU read (see
 *  {@link installLazyCpu}). Strided TANGENT/TEXCOORD_1/COLOR are eagerly
 *  de-strided (they feed device-lost recovery), but no current asset interleaves
 *  them. Tight attributes resolve exactly like the core loader. */
export function buildInterleavedPartial(json: any, binChunk: DataView, primitive: any, worldMatrix: Mat4, nodeIdx: number): Omit<GltfMeshData, "_material"> | undefined {
    const attrs = primitive.attributes;

    // Per-primitive gate: bail (→ tight path) unless a vertex attribute is strided.
    let anyStrided = false;
    for (const name in attrs) {
        if (accessorIsStrided(json, attrs[name])) {
            anyStrided = true;
            break;
        }
    }
    if (!anyStrided) {
        return undefined;
    }

    const vb: GltfVb = {};
    let vertexCount = 0;

    // Resolve one attribute. Returns the interleave descriptor (when the source is
    // strided) and/or a tight CPU array. `eager` de-strides strided sources up-front
    // (TANGENT/UV2/COLOR feed device-lost recovery); lazy ones leave `_tight` null and
    // are de-strided on demand. The caller assigns `vb.<attr>` with a STATIC property
    // name (never a computed `vb[key]`) — a computed write would stay an unmangled
    // literal while every reader uses the mangled static name, corrupting the object
    // across the dynamic-import chunk boundary.
    const resolveOne = (name: string, eager: boolean): { _tight: Float32Array | null; _il?: AccessorInterleave; _count: number } => {
        const idx = attrs[name];
        if (idx === undefined) {
            return { _tight: null, _count: 0 };
        }
        if (accessorIsStrided(json, idx)) {
            const il = resolveStrided(json, binChunk, idx);
            return { _tight: eager ? destrideToTight(il) : null, _il: il, _count: il._count };
        }
        const av = resolveAccessor(json, binChunk, idx);
        return { _tight: av._data as Float32Array, _count: av._count };
    };

    const pos = resolveOne("POSITION", false);
    vb._p = pos._il;
    vertexCount = pos._count;
    const nrm = resolveOne("NORMAL", false);
    vb._n = nrm._il;
    const uv = resolveOne("TEXCOORD_0", false);
    vb._u = uv._il;
    const tan = resolveOne("TANGENT", true);
    vb._t = tan._il;
    const uv2 = resolveOne("TEXCOORD_1", true);
    vb._u2 = uv2._il;
    const col = resolveOne("COLOR_0", true);
    vb._c = col._il;

    const positions = pos._tight;
    let normals = nrm._tight;
    let uvs = uv._tight;
    const tangents = tan._tight;
    const uv2s = uv2._tight;
    const colors = col._tight;

    // Absent (not merely strided) NORMAL/UV need a tight zero-filled buffer so the
    // GPU has a bindable vertex buffer — matches the core loader's tight path.
    if (!normals && !vb._n) {
        normals = new Float32Array(vertexCount * 3);
    }
    if (!uvs && !vb._u) {
        uvs = new Float32Array(vertexCount * 2);
    }

    const idxData = primitive.indices !== undefined ? resolveAccessor(json, binChunk, primitive.indices) : null;
    const indices = idxData
        ? idxData._data instanceof Uint32Array
            ? new Uint32Array(idxData._data)
            : idxData._data instanceof Uint8Array
              ? Uint16Array.from(idxData._data)
              : new Uint16Array(idxData._data.buffer, idxData._data.byteOffset, idxData._count)
        : new Uint16Array(0);

    return {
        _positions: positions,
        _normals: normals,
        _tangents: tangents,
        _uvs: uvs,
        _uv2s: uv2s,
        _colors: colors,
        _indices: indices,
        _vertexCount: vertexCount,
        _indexCount: idxData?._count ?? 0,
        _worldMatrix: worldMatrix,
        _vb: vb,
        _nodeIndex: nodeIdx,
        _primitive: primitive,
    };
}

/** Build the GPU geometry for an interleaved mesh: one shared buffer per
 *  bufferView for strided attributes (bound at offset with arrayStride), tight
 *  attributes get their own buffer — byte-identical to non-interleaved meshes.
 *  The raw `_slice` is intentionally retained on `_vb` so the CPU copy can be
 *  de-strided lazily later (see {@link installLazyCpu}). */
function buildInterleavedGpu(engine: EngineContext, m: GltfMeshData): MeshGPU {
    const vbsrc = m._vb!;
    const shared = new Map<number, GPUBuffer>();
    const vbuf = (a: AccessorInterleave | undefined, tight: Float32Array | null): GPUBuffer | null => {
        if (!a) {
            return tight ? createMappedBuffer(engine, tight, GPUBufferUsage.VERTEX) : null;
        }
        let b = shared.get(a._bufferView);
        if (!b) {
            shared.set(a._bufferView, (b = createMappedBuffer(engine, a._slice!, GPUBufferUsage.VERTEX)));
        }
        return b;
    };
    return {
        positionBuffer: vbuf(vbsrc._p, m._positions)!,
        normalBuffer: vbuf(vbsrc._n, m._normals)!,
        tangentBuffer: m._tangents ? vbuf(vbsrc._t, m._tangents) : null,
        uvBuffer: vbuf(vbsrc._u, m._uvs)!,
        uv2Buffer: m._uv2s ? vbuf(vbsrc._u2, m._uv2s) : null,
        colorBuffer: m._colors ? vbuf(vbsrc._c, m._colors) : null,
        indexBuffer: createMappedBuffer(engine, m._indices, GPUBufferUsage.INDEX),
        indexCount: m._indexCount,
        indexFormat: (m._indices instanceof Uint32Array ? "uint32" : "uint16") as GPUIndexFormat,
        _vbLayout: vbsrc,
        _vbKey: `vb${vbsrc._p?._stride ?? 0}.${vbsrc._n?._stride ?? 0}.${vbsrc._t?._stride ?? 0}.${vbsrc._u?._stride ?? 0}`,
    };
}

/** Build a complete engine mesh from interleaved glTF mesh-data. Owns ALL
 *  interleave-specific work (GPU upload, AABB fold, lazy CPU install, device-lost
 *  retention) so the core loader's tight path stays byte-identical to the
 *  non-interleaved engine — keeping interleave bytes out of every glTF scene that
 *  doesn't use it. */
export function buildInterleavedMesh(engine: EngineContext, m: GltfMeshData, index: number, material: PbrMaterialProps): Mesh {
    const gpu = buildInterleavedGpu(engine, m);

    // AABB: fold strided positions straight from the slice; tight positions normally.
    const [boundMin, boundMax] = m._vb!._p ? computeAabbStrided(m._vb!._p, m._worldMatrix) : computeAabb(m._positions!, m._worldMatrix);

    const mesh = {
        name: `gltf_mesh_${index}`,
        material,
        receiveShadows: false,
        boundMin,
        boundMax,
        skeleton: null,
        morphTargets: null,
        _materialDirty: false,
        _gpu: gpu,
    } as unknown as Mesh;
    initMeshTransform(mesh);

    // Lazy CPU geometry: the de-strided tight copy is built only on first read.
    installLazyCpu(mesh, m);
    mesh._cpuIndices = m._indices instanceof Uint32Array ? m._indices : new Uint32Array(m._indices);
    engine._dlr?.m(mesh, m._uv2s, m._tangents, m._colors, m._indices, gpu.indexFormat);

    return mesh as Mesh;
}

/** Fold an AABB directly over an interleaved (strided) FLOAT vec3 position
 *  source — no tight copy is materialized. Mirrors {@link computeAabb}'s
 *  world-transform handling. All current interleaved assets use FLOAT positions. */
export function computeAabbStrided(il: AccessorInterleave, world?: Mat4): Aabb {
    const dv = new DataView(il._slice!.buffer, il._slice!.byteOffset, il._slice!.byteLength);
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let v = 0; v < il._count; v++) {
        const base = il._offset + v * il._stride;
        const lx = dv.getFloat32(base, true);
        const ly = dv.getFloat32(base + 4, true);
        const lz = dv.getFloat32(base + 8, true);
        let x = lx,
            y = ly,
            z = lz;
        if (world) {
            x = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
            y = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
            z = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
        }
        if (x < minX) {
            minX = x;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (z > maxZ) {
            maxZ = z;
        }
    }
    return [
        [minX, minY, minZ],
        [maxX, maxY, maxZ],
    ];
}

/** Install lazy CPU-geometry accessors on an interleaved mesh. Each of
 *  `_cpuPositions/_cpuNormals/_cpuUvs` that comes from a strided source is
 *  defined as a getter that de-strides a tight copy on first access and caches
 *  it; tight attributes are assigned directly. A mesh that is never picked /
 *  CSG'd / navigated never materializes the de-strided arrays.
 *
 *  The property names are written as STATIC literals (not a computed key) so the
 *  minifier mangles them identically to the static reads in the picking /
 *  device-lost code — a computed `defineProperty(mesh, key)` would leave the name
 *  an unmangled literal and mismatch those reads across the chunk boundary. */
export function installLazyCpu(mesh: any, m: GltfMeshData): void {
    const vb = m._vb!;
    if (vb._p) {
        Object.defineProperty(mesh, "_cpuPositions", lazyCpuDesc(vb._p));
    } else if (m._positions) {
        mesh._cpuPositions = m._positions;
    }
    if (vb._n) {
        Object.defineProperty(mesh, "_cpuNormals", lazyCpuDesc(vb._n));
    } else if (m._normals) {
        mesh._cpuNormals = m._normals;
    }
    if (vb._u) {
        Object.defineProperty(mesh, "_cpuUvs", lazyCpuDesc(vb._u));
    } else if (m._uvs) {
        mesh._cpuUvs = m._uvs;
    }
}

/** Build a caching lazy-getter descriptor that de-strides `il` on first read. */
function lazyCpuDesc(il: AccessorInterleave): PropertyDescriptor {
    let cached: Float32Array | undefined;
    return {
        configurable: true,
        enumerable: true,
        get(): Float32Array {
            return (cached ??= destrideToTight(il));
        },
        set(v: Float32Array): void {
            cached = v;
        },
    };
}
