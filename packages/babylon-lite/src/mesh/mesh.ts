/** High-level Mesh — position/rotation/scaling + material + GPU geometry.
 *  Plain data (no scene reference). The scene collects meshes via addToScene(). */

import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import type { Material } from "../material/material.js";
import type { SkeletonData, MorphTargetData, VatData } from "../animation/types.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import type { ThinInstanceData } from "./thin-instance.js";
import type { WorldAabbAcc } from "./mesh-world-bounds.js";
import { createWorldMatrixState, attachWorldMatrixState, composeTrsLocalMatrix } from "../scene/world-matrix-state.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createEulerProxy } from "../scene/scene-node.js";
import { eulerToQuat } from "../math/quat-euler.js";

// ─── Mesh GPU Geometry ───────────────────────────────────────────────

/** Per-attribute interleave override. When present, the attribute's GPU buffer
 *  is a shared interleaved slice: the pipeline uses `_stride` as the vertex
 *  buffer arrayStride and `_offset` as the layout `attributes[].offset`, while the
 *  draw binds the buffer at offset 0 (mirrors Babylon.js WebGPU; a non-zero
 *  setVertexBuffer bind offset corrupts vertex fetch on some AMD/Dawn paths).
 *  Absent attributes use the canonical tight layout (own buffer, default stride,
 *  offset 0) — byte-identical to non-interleaved meshes. */
export interface MeshVbAttr {
    /** @internal Vertex buffer arrayStride for this attribute's pipeline layout entry. */
    readonly _stride: number;
    /** @internal Byte offset within the shared buffer, encoded in the pipeline vertex
     *  layout `attributes[].offset` (the buffer is bound at offset 0). */
    readonly _offset: number;
}

/** Optional per-attribute interleave layout. Only set for meshes that source one
 *  or more attributes from a strided (interleaved) glTF bufferView. */
export interface MeshVbLayout {
    /** @internal */
    readonly _p?: MeshVbAttr;
    /** @internal */
    readonly _n?: MeshVbAttr;
    /** @internal */
    readonly _t?: MeshVbAttr;
    /** @internal */
    readonly _u?: MeshVbAttr;
    /** @internal */
    readonly _u2?: MeshVbAttr;
    /** @internal */
    readonly _c?: MeshVbAttr;
}

/** Opaque GPU geometry handle (user never touches these). */
export interface MeshGPU {
    readonly positionBuffer: GPUBuffer;
    readonly normalBuffer: GPUBuffer;
    readonly tangentBuffer?: GPUBuffer | null;
    readonly uvBuffer: GPUBuffer;
    readonly uv2Buffer?: GPUBuffer | null;
    readonly colorBuffer?: GPUBuffer | null;
    readonly hasUv?: boolean;
    readonly hasUv2?: boolean;
    readonly hasTangent?: boolean;
    readonly hasColor?: boolean;
    readonly indexBuffer: GPUBuffer;
    readonly indexCount: number;
    readonly indexFormat: GPUIndexFormat;
    /** @internal First vertex of this mesh within a shared vertex allocation, applied as the
     *  draw call's `baseVertex`. Lets many meshes take slots in one GPU-resident slab without
     *  a non-zero `setVertexBuffer` bind offset. Undefined/0 → canonical behaviour. */
    readonly _baseVertex?: number;
    /** @internal When false, disposing the mesh does NOT destroy its vertex-side buffers —
     *  they are BORROWED from a longer-lived allocation (a GPU-resident slab shared by many
     *  meshes) and must outlive this mesh. Without it, retiring one slot destroys the slab
     *  every other slot is still drawing from. Defaults to owning. */
    readonly _ownsVertexBuffers?: boolean;
    /** @internal When false, disposing the mesh does NOT destroy `indexBuffer` — the topology
     *  is shared across meshes and owned by the caller. Defaults to owning. */
    readonly _ownsIndexBuffer?: boolean;
    /** @internal Reserved vertex capacity for grow-only procedural geometry. */
    _vertexCapacity?: number;
    /** @internal Reserved index capacity for grow-only procedural geometry. */
    _indexCapacity?: number;
    /** @internal Reused padded indices whose inactive tail is degenerate. */
    _indexScratch?: Uint32Array;
    /** @internal Per-attribute interleave layout. Undefined → all attributes tight (default). */
    readonly _vbLayout?: MeshVbLayout;
    /** @internal Precomputed pipeline cache-key suffix for this mesh's interleave layout.
     *  Built once by the interleave module so the hot render path never assembles
     *  it. Undefined → tight mesh (empty suffix, byte-identical pipeline key). */
    readonly _vbKey?: string;
    /** @internal Extra-owner count when geometry is shared across glTF nodes or mesh clones.
     *  See resource/ref-count.ts. Absent/undefined means exactly one (implicit) owner. */
    _refCount?: number;
    /** @internal Rebuild one shared geometry per replacement device. Installed only
     *  by the glTF sharing path, so ordinary meshes pay no recovery-state cost. */
    _recoverShared?: (engine: EngineContext, mesh: Mesh, upload: (engine: EngineContext, mesh: Mesh) => MeshGPU) => MeshGPU;
}

// ─── Mesh ────────────────────────────────────────────────────────────

/** A renderable mesh — plain data with transform, material, and GPU geometry.
 *  Works with both standard and PBR pipelines; routing is based on material type.
 *  Extends SceneNode for the full TRS + parent + children hierarchy. */
export interface Mesh extends SceneNode {
    /** Unique ID from source file (e.g. .babylon). Used for light include/exclude filtering. */
    id?: string;
    material: Material;
    receiveShadows: boolean;
    /** OBJECT-LOCAL axis-aligned bounding box of this mesh's own geometry — the box the vertex
     *  buffer occupies BEFORE `worldMatrix`, and before any thin-instance matrix. Every reader
     *  composes it the same way the shaders do:
     *    plain mesh        → `worldMatrix × corner`
     *    thin-instanced    → `worldMatrix × instanceMatrix × corner`
     *
     *  Local, not world, because it is the only frame that survives the mesh moving. A `Mesh` owns a
     *  live TRS plus a parent chain, so a world-baked box goes stale the instant anything in that chain
     *  changes and there is no way to recover the local box from it. Local also is the only frame in which
     *  a thin-instance prototype can be expressed at all: one prototype box is reused under hundreds of
     *  instance matrices, so it cannot hold any one instance's world placement. The shadow fit
     *  (`computeDirectionalLightMatrix`, `_castersWorldAabb`), the GPU thin-instance cull, the Havok shape
     *  extents and `computeMaxExtents` all rely on exactly this.
     *
     *  This used to be documented as world-space, and the glTF loader honoured that by baking the node's
     *  world matrix in while leaving the mesh parented under that same node — so every reader that
     *  (correctly) applied `worldMatrix` transformed loaded meshes twice, and CSM cascades mis-fit for any
     *  parented glTF caster. Loaders now publish the raw geometry box and let the node chain supply the
     *  transform, which is lossless: the mesh's `worldMatrix` already reproduces that node's world matrix.
     *  Consumers that need a loaded model's box in its ROOT frame must compose it with the node
     *  world-at-load matrix themselves.
     *
     *  A consumer MAY overwrite these with a wider hand-computed box (e.g. a thin-instance prototype
     *  publishing the union of all its placements onto an identity-world mesh) — the contract is only that
     *  the box is stated in the frame `worldMatrix` maps out of. */
    boundMin?: [number, number, number];
    boundMax?: [number, number, number];
    /** Skeleton GPU data (skeletal animation). Type-only — no module dependency. */
    skeleton?: SkeletonData | null;
    /** Baked vertex-animation (VAT) GPU data — replaces live skinning so the mesh thin-instances.
     *  Mutually exclusive with live `skeleton` skinning. Type-only — no module dependency. */
    vat?: VatData | null;
    /** Morph target GPU data. Type-only — no module dependency. */
    morphTargets?: MorphTargetData | null;
    /** @internal Route this thin-instanced mesh through scene-local runtime materialization. */
    _runtimeThinBuild?: (scene: import("../scene/scene-core.js").SceneContext, mesh: Mesh, pending?: Promise<void>) => Promise<void>;
    /** User-controlled render order. Lower = drawn first within phase.
     *  Only affects ordering within the opaque or transparent phase. */
    renderOrder?: number;
    /** On a transmission-enabled render task, draw this transparent mesh LAST — after the transmissive
     *  surface and after the scene-colour grab — so it sits on top of the water/glass AND is excluded from
     *  what that surface refracts (e.g. lily pads resting on water should not appear in the refraction).
     *  Enable transmission on the task with `enableRenderTaskTransmission`; only transparent surfaces
     *  (`needAlphaBlending`) are deferred. No effect on tasks without transmission. */
    renderOnTop?: boolean;
    /** Thin instance data (CPU-side). GPU buffer managed by render system. */
    thinInstances?: ThinInstanceData | null;
    /** @internal Optional feature-owned setup-time world-bounds expansion. */
    _expandWorldBounds?: (bounds: WorldAabbAcc, mesh: Mesh) => void;
    /** Explicit opt-in that this mesh's RGBA vertex or thin-instance colours drive
     *  translucency (Babylon `AbstractMesh.hasVertexAlpha`). When `true` and the mesh
     *  carries either colour source, the Standard forward path treats it as
     *  alpha-blended: source-over blending, depth-write disabled, and sorted into the
     *  transparent phase. The geometry path applies the same behavior for vertex
     *  colours. Defaults to `false`/opaque. Set this explicitly (or via a loader that
     *  knows the vertex-colour accessor is VEC4); Lite never scans buffers to infer it. */
    hasVertexAlpha?: boolean;
    /** When `false`, the GPU picker skips this mesh.  Defaults to `true`
     *  (undefined behaves as pickable).  Mirrors BJS `AbstractMesh.isPickable`. */
    pickable?: boolean;
    // name, children, position, rotation, rotationQuaternion, scaling,
    // parent, worldMatrix, worldMatrixVersion — all inherited from SceneNode

    /** @internal */
    _gpu: MeshGPU;
    /** @internal Set by `disposeMeshGpu`: this mesh released its claim on every GPU resource it
     *  owned and is retired for good. Buffers whose last claim went away are already destroyed;
     *  surviving ones now belong to their remaining owners only. Either way the mesh must never
     *  re-enter a scene — it would draw with dead handles, or release a second claim it no longer
     *  holds and free buffers a sibling still renders with. `addToScene` rejects it, repeat
     *  `disposeMeshGpu` calls are no-ops (so the idempotent `removeFromScene` stays idempotent),
     *  and `cloneTransformNode` refuses it — cloning retired geometry is the same bug wearing a
     *  new name, and the clone's claims could never be released. */
    _disposed?: boolean;
    /** @internal Sign of the world-matrix 3x3 determinant the geometry's triangle winding was
     *  authored for. Procedural meshes default to `+1`; the glTF loader marks its meshes `-1`
     *  because they live under the RH→LH `__root__` flip. `enableMirroredMeshes()` reverses winding
     *  whenever a mesh's current world determinant sign disagrees with this. */
    _authoredSign?: number;
    /** @internal Reason cloning this mesh is currently forbidden. */
    _clone?: string;
    /** @internal Non-triangle primitive topology index: 1=point-list, 2=line-list,
     *  3=line-strip, 4=triangle-strip. Undefined means triangle-list. */
    _topology?: number;
    /** @internal Per-polyline point counts retained by createLineSystem for stable-topology updates. */
    _linePointCounts?: Uint32Array;
    /** @internal Creation-time dash/gap ratio retained by createDashedLines for stable-topology updates. */
    _dashedLineOptions?: readonly [dashSize: number, gapSize: number];
    /** @internal Highest CSM cascade this mesh casts into; undefined means all cascades. */
    _shadowMaxCascade?: number;
    /** @internal */
    _cpuPositions?: Float32Array;
    /** @internal */
    _cpuNormals?: Float32Array;
    /** @internal */
    _cpuUvs?: Float32Array;
    /** @internal */
    _cpuUv2s?: Float32Array | null;
    /** @internal */
    _cpuTangents?: Float32Array | null;
    /** @internal */
    _cpuColors?: Float32Array | null;
    /** @internal */
    _cpuIndices?: Uint32Array;
    /** @internal */
    _cpuGpuIndices?: Uint16Array | Uint32Array;
    /** @internal */
    _cpuIndexFormat?: GPUIndexFormat;
}

/** Wire ObservableVec3/ObservableQuat TRS and children onto a partially-built mesh object.
 *  Used by all mesh creation paths (factories, loaders). */
export function initMeshTransform(partialMesh: Partial<Mesh> & { _flatNormal?: boolean }, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): Mesh {
    const wm = createWorldMatrixState(() => composeTrsLocalMatrix(mesh.position, mesh.rotationQuaternion, mesh.scaling));
    const onWmDirty = () => wm.markLocalDirty();

    const [iqx, iqy, iqz, iqw] = eulerToQuat(rx, ry, rz);
    const rq = new ObservableQuat(iqx, iqy, iqz, iqw, onWmDirty);
    const rotationQuaternion = rq;
    const rotation = createEulerProxy(rq);
    const position = new ObservableVec3(px, py, pz, onWmDirty);
    const scaling = new ObservableVec3(sx, sy, sz, onWmDirty);

    const mesh = { ...partialMesh, position, rotationQuaternion, rotation, scaling } as Mesh;

    if (!(mesh as unknown as Record<string, unknown>).children) {
        (mesh as unknown as Record<string, unknown>).children = [];
    }

    Object.defineProperty(mesh, "parent", {
        get() {
            return wm.parent;
        },
        set(v) {
            wm.parent = v;
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(mesh, "worldMatrix", {
        get() {
            return wm.getWorldMatrix();
        },
        configurable: true,
        enumerable: false,
    });
    Object.defineProperty(mesh, "worldMatrixVersion", {
        get() {
            return wm.getWorldMatrixVersion();
        },
        configurable: true,
        enumerable: false,
    });
    attachWorldMatrixState(mesh, wm);
    return mesh;
}

// ─── GPU Geometry Upload ─────────────────────────────────────────────

/** Upload typed arrays to GPU buffers and return a MeshGPU handle. */
export function uploadMeshToGPU(
    engine: EngineContext,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): MeshGPU {
    const device = engine._device;
    const positionBuffer = createMappedBuffer(engine, positions, BU.VERTEX);
    const normalBuffer = createMappedBuffer(engine, normals, BU.VERTEX);
    const indexBuffer = createMappedBuffer(engine, indices, BU.INDEX);

    // UVs: use provided or create zero-filled buffer
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createMappedBuffer(engine, uvs, BU.VERTEX);
    } else {
        uvBuffer = device.createBuffer({
            size: (positions.length / 3) * 8,
            usage: BU.VERTEX,
            mappedAtCreation: true,
        });
        uvBuffer.unmap();
    }

    // UV2: only create if provided
    let uv2Buffer: GPUBuffer | null = null;
    if (uvs2 && uvs2.length > 0) {
        uv2Buffer = createMappedBuffer(engine, uvs2, BU.VERTEX);
    }

    const tangentBuffer = tangents && tangents.length > 0 ? createMappedBuffer(engine, tangents, BU.VERTEX) : null;
    const colorBuffer = colors && colors.length > 0 ? createMappedBuffer(engine, colors, BU.VERTEX) : null;

    return {
        positionBuffer,
        normalBuffer,
        uvBuffer,
        uv2Buffer,
        tangentBuffer,
        colorBuffer,
        hasUv: !!uvs && uvs.length > 0,
        hasUv2: !!uvs2 && uvs2.length > 0,
        hasTangent: !!tangents && tangents.length > 0,
        hasColor: !!colors && colors.length > 0,
        indexBuffer,
        indexCount: indices.length,
        indexFormat: "uint32",
    };
}
