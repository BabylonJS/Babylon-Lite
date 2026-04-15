/** High-level Mesh — position/rotation/scaling + material + GPU geometry.
 *  Plain data (no scene reference). The scene collects meshes via addToScene(). */

import type { EngineContextInternal } from "../engine/engine.js";
import { mat4Compose, mat4Identity } from "../math/mat4.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { SkeletonData, MorphTargetData } from "../animation/types.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import type { ThinInstanceData } from "./thin-instance.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import type { SceneNode } from "../scene/scene-node.js";
import { eulerToQuat, createEulerProxy } from "../scene/scene-node.js";

// ─── Mesh GPU Geometry ───────────────────────────────────────────────

/** Opaque GPU geometry handle (user never touches these). */
export interface MeshGPU {
    readonly positionBuffer: GPUBuffer;
    readonly normalBuffer: GPUBuffer;
    readonly tangentBuffer?: GPUBuffer | null;
    readonly uvBuffer: GPUBuffer;
    readonly uv2Buffer?: GPUBuffer | null;
    readonly indexBuffer: GPUBuffer;
    readonly indexCount: number;
    readonly indexFormat: GPUIndexFormat;
}

// ─── Mesh ────────────────────────────────────────────────────────────

/** A renderable mesh — plain data with transform, material, and GPU geometry.
 *  Works with both standard and PBR pipelines; routing is based on material type.
 *  Extends SceneNode for the full TRS + parent + children hierarchy. */
export interface Mesh extends SceneNode {
    /** Unique ID from source file (e.g. .babylon). Used for light include/exclude filtering. */
    id?: string;
    material: StandardMaterialProps | PbrMaterialProps;
    receiveShadows: boolean;
    /** World-space bounding box (set by loaders for camera framing). */
    boundMin?: [number, number, number];
    boundMax?: [number, number, number];
    /** Skeleton GPU data (skeletal animation). Type-only — no module dependency. */
    skeleton?: SkeletonData | null;
    /** Morph target GPU data. Type-only — no module dependency. */
    morphTargets?: MorphTargetData | null;
    /** User-controlled render order. Lower = drawn first within phase.
     *  Only affects ordering within the opaque or transparent phase. */
    renderOrder?: number;
    /** Thin instance data (CPU-side). GPU buffer managed by render system. */
    thinInstances?: ThinInstanceData | null;
    // name, children, position, rotation, rotationQuaternion, scaling,
    // parent, worldMatrix, worldMatrixVersion — all inherited from SceneNode
}

/** @internal Mesh with internal GPU fields — for engine/renderable code only. Not re-exported from index.ts. */
export interface MeshInternal extends Mesh {
    _materialDirty: boolean;
    readonly _gpu: MeshGPU;
    _cpuPositions?: Float32Array;
    _cpuNormals?: Float32Array;
    _cpuUvs?: Float32Array;
    _cpuIndices?: Uint32Array;
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
}

// ─── GPU Geometry Upload ─────────────────────────────────────────────

/** Upload typed arrays to GPU buffers and return a MeshGPU handle. */
export function uploadMeshToGPU(
    engine: EngineContextInternal,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array
): MeshGPU {
    const device = engine.device;
    const positionBuffer = createGpuBuffer(engine, positions, GPUBufferUsage.VERTEX);
    const normalBuffer = createGpuBuffer(engine, normals, GPUBufferUsage.VERTEX);
    const indexBuffer = createGpuBuffer(engine, indices, GPUBufferUsage.INDEX);

    // UVs: use provided or create zero-filled buffer
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createGpuBuffer(engine, uvs, GPUBufferUsage.VERTEX);
    } else {
        uvBuffer = device.createBuffer({
            size: (positions.length / 3) * 8,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        uvBuffer.unmap();
    }

    // UV2: only create if provided
    let uv2Buffer: GPUBuffer | null = null;
    if (uvs2 && uvs2.length > 0) {
        uv2Buffer = createGpuBuffer(engine, uvs2, GPUBufferUsage.VERTEX);
    }

    return {
        positionBuffer,
        normalBuffer,
        uvBuffer,
        uv2Buffer,
        indexBuffer,
        indexCount: indices.length,
        indexFormat: "uint32",
    };
}

function createGpuBuffer(engine: EngineContextInternal, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
}
