/** High-level Mesh — position/rotation/scaling + material + GPU geometry.
 *  Plain data (no scene reference). The scene collects meshes via addToScene(). */

import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { mat4Compose } from "../math/mat4-compose.js";
import { mat4Identity } from "../math/mat4-identity.js";
import type { Material } from "../material/material.js";
import type { SkeletonData, MorphTargetData, VatData } from "../animation/types.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import type { ThinInstanceData } from "./thin-instance.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../scene/world-matrix-state.js";
import type { SceneNode } from "../scene/scene-node.js";
import { eulerToQuat, createEulerProxy } from "../scene/scene-node.js";

// ─── Mesh GPU Geometry ───────────────────────────────────────────────

/** Per-attribute interleave override. When present, the attribute's GPU buffer
 *  is a shared interleaved slice: the pipeline uses `_stride` as the vertex
 *  buffer arrayStride and the draw binds the buffer at byte offset `_offset`.
 *  Absent attributes use the canonical tight layout (own buffer, default stride,
 *  offset 0) — byte-identical to non-interleaved meshes. */
export interface MeshVbAttr {
    /** @internal Vertex buffer arrayStride for this attribute's pipeline layout entry. */
    readonly _stride: number;
    /** @internal Byte offset passed to setVertexBuffer (bind offset into the shared buffer). */
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
    /** @internal Per-attribute interleave layout. Undefined → all attributes tight (default). */
    readonly _vbLayout?: MeshVbLayout;
    /** @internal Precomputed pipeline cache-key suffix for this mesh's interleave layout.
     *  Built once by the interleave module so the hot render path never assembles
     *  it. Undefined → tight mesh (empty suffix, byte-identical pipeline key). */
    readonly _vbKey?: string;
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
    /** World-space bounding box (set by loaders for camera framing). */
    boundMin?: [number, number, number];
    boundMax?: [number, number, number];
    /** Skeleton GPU data (skeletal animation). Type-only — no module dependency. */
    skeleton?: SkeletonData | null;
    /** Baked vertex-animation (VAT) GPU data — replaces live skinning so the mesh thin-instances.
     *  Mutually exclusive with live `skeleton` skinning. Type-only — no module dependency. */
    vat?: VatData | null;
    /** Morph target GPU data. Type-only — no module dependency. */
    morphTargets?: MorphTargetData | null;
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
    /** When `false`, the GPU picker skips this mesh.  Defaults to `true`
     *  (undefined behaves as pickable).  Mirrors BJS `AbstractMesh.isPickable`. */
    pickable?: boolean;
    // name, children, position, rotation, rotationQuaternion, scaling,
    // parent, worldMatrix, worldMatrixVersion — all inherited from SceneNode

    /** @internal */
    _gpu: MeshGPU;
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
export function initMeshTransform(mesh: Mesh, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
    const wm = createWorldMatrixState(() => {
        const p = mesh.position,
            rq = mesh.rotationQuaternion,
            s = mesh.scaling;
        const isIdentity = p.x === 0 && p.y === 0 && p.z === 0 && rq.x === 0 && rq.y === 0 && rq.z === 0 && rq.w === 1 && s.x === 1 && s.y === 1 && s.z === 1;
        return isIdentity ? mat4Identity() : mat4Compose(p.x, p.y, p.z, rq.x, rq.y, rq.z, rq.w, s.x, s.y, s.z);
    });
    const onWmDirty = () => wm.markLocalDirty();

    const [iqx, iqy, iqz, iqw] = eulerToQuat(rx, ry, rz);
    const rq = new ObservableQuat(iqx, iqy, iqz, iqw, onWmDirty);
    mesh.rotationQuaternion = rq;
    mesh.rotation = createEulerProxy(rq);
    mesh.position = new ObservableVec3(px, py, pz, onWmDirty);
    mesh.scaling = new ObservableVec3(sx, sy, sz, onWmDirty);

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
