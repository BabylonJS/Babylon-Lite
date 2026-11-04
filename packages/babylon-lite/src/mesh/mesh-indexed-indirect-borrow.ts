import type { Mesh, MeshGPU } from "./mesh.js";
import type { EngineContext } from "../engine/engine.js";
import { bumpVisibilityEpoch } from "../engine/engine.js";
import { BU } from "../engine/gpu-flags.js";
import { _getStorageBufferHandle, type StorageBuffer } from "../resource/storage-buffer.js";
import { _installShaderIndexedDrawResolver, type ShaderPacket } from "../material/shader/shader-renderable.js";
import { _installMeshRetirementObserver } from "./mesh-dispose.js";
import { _getMeshScenes, _installMeshMaterialValidator, markMeshRenderableDirty } from "../scene/mesh-scene-registry.js";

// Kept separate from `mesh-indexed-indirect.ts`: that ABI module is statically imported by
// thin-instance paths, so importing renderer seams there reshapes every such scene's chunks.

/** CPU-visible draw information. GPU-authored counts are unknown, not capacity estimates. */
export interface MeshIndexedDrawInfo {
    readonly mode: "direct" | "indirect";
    readonly indexCapacity: number;
    readonly indexCount: number | null;
    readonly instanceCount: number | null;
}

interface Borrow {
    readonly buffer: StorageBuffer;
    readonly byteOffset: number;
    readonly geometry: MeshGPU;
    readonly vertices: StorageBuffer;
    readonly indices?: StorageBuffer;
}

let borrows: WeakMap<Mesh, Borrow> | null = null;
let installed = false;

function assertMesh(mesh: Mesh): void {
    if (mesh._disposed) {
        throw new Error("setMeshIndexedIndirect: mesh has been disposed.");
    }
    if (mesh.thinInstances) {
        throw new Error("setMeshIndexedIndirect: only plain meshes without thin instances are supported.");
    }
    if (mesh.material?._buildGroup._materialFamily !== "shader") {
        throw new Error("setMeshIndexedIndirect: mesh must use a ShaderMaterial.");
    }
    if (mesh._gpu._ownsVertexBuffers !== false) {
        throw new Error("setMeshIndexedIndirect: mesh must have storage-backed geometry.");
    }
}

function findSource(engine: EngineContext, handle: GPUBuffer): StorageBuffer {
    for (const source of engine._storageBuffers ?? []) {
        if (source._buffer === handle) {
            _getStorageBufferHandle(engine, source);
            return source;
        }
    }
    throw new Error("setMeshIndexedIndirect: storage-backed geometry must belong to the same engine and device; recreate its allocations and mesh.");
}

function validate(engine: EngineContext, mesh: Mesh, borrow: Borrow): GPUBuffer {
    assertMesh(mesh);
    if (mesh._gpu !== borrow.geometry || mesh._gpu.positionBuffer !== _getStorageBufferHandle(engine, borrow.vertices)) {
        throw new Error("setMeshIndexedIndirect: geometry changed; recreate or explicitly rebind the consumer.");
    }
    if (borrow.indices && mesh._gpu.indexBuffer !== _getStorageBufferHandle(engine, borrow.indices)) {
        throw new Error("setMeshIndexedIndirect: index allocation changed; explicitly rebind the consumer.");
    }
    return _getStorageBufferHandle(engine, borrow.buffer);
}

/** Borrow the five GPU-authored indexed-indirect words at an aligned byte offset.
 *  Pass null to restore the CPU draw. The allocation remains caller-owned; clones
 *  require their own binding. GPU-role allocations and their producers must be
 *  recreated/rerun after device loss. No argument word is read or overwritten. */
export function setMeshIndexedIndirect(mesh: Mesh, buffer: StorageBuffer | null, byteOffset = 0): void {
    if (mesh._disposed) {
        throw new Error("setMeshIndexedIndirect: mesh has been disposed.");
    }
    if (buffer !== null && (!buffer || typeof buffer !== "object")) {
        throw new Error("setMeshIndexedIndirect: arguments must be a live StorageBuffer or null.");
    }
    const previous = borrows?.get(mesh);
    let next: Borrow | undefined;
    if (buffer) {
        assertMesh(mesh);
        const engine = buffer._engine;
        _getStorageBufferHandle(engine, buffer);
        if (engine._currentEncoder) {
            throw new Error("setMeshIndexedIndirect: cannot change a borrow while a frame encoder is active.");
        }
        if ((buffer._usage & BU.INDIRECT) === 0) {
            throw new Error("setMeshIndexedIndirect: arguments must be created with { indirect: true }.");
        }
        if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) {
            throw new Error("setMeshIndexedIndirect: byteOffset must be a non-negative safe integer and multiple of 4.");
        }
        if (byteOffset > buffer.byteLength - 20) {
            throw new Error(`setMeshIndexedIndirect: twenty-byte arguments at offset ${byteOffset} exceed the buffer's ${buffer.byteLength}-byte capacity.`);
        }
        const vertices = findSource(engine, mesh._gpu.positionBuffer);
        const indices = mesh._gpu._ownsIndexBuffer === false ? findSource(engine, mesh._gpu.indexBuffer) : undefined;
        next = { buffer, byteOffset, geometry: mesh._gpu, vertices, indices };
        if (previous?.buffer === buffer && previous.byteOffset === byteOffset && previous.geometry === mesh._gpu) {
            return;
        }
    } else {
        if (byteOffset !== 0) {
            throw new Error("setMeshIndexedIndirect: unbinding requires byteOffset zero.");
        }
        if (previous?.buffer._engine._currentEncoder) {
            throw new Error("setMeshIndexedIndirect: cannot change a borrow while a frame encoder is active.");
        }
        if (!previous) {
            return;
        }
    }
    if (next) {
        (borrows ??= new WeakMap()).set(mesh, next);
    } else {
        borrows!.delete(mesh);
    }
    if (!installed) {
        installed = true;
        _installShaderIndexedDrawResolver({
            update(engine, mesh) {
                const borrow = borrows?.get(mesh);
                if (borrow) {
                    validate(engine, mesh, borrow);
                }
            },
            draw(pass, engine, mesh) {
                const borrow = borrows?.get(mesh);
                if (!borrow) {
                    return false;
                }
                pass.drawIndexedIndirect(validate(engine, mesh, borrow), borrow.byteOffset);
                return true;
            },
        });
        _installMeshRetirementObserver((retired) => borrows?.delete(retired));
        _installMeshMaterialValidator((target, material) => {
            if (borrows?.has(target)) {
                if (material?._buildGroup._materialFamily !== "shader") {
                    throw new Error("setMeshIndexedIndirect: unbind arguments before replacing ShaderMaterial with another material family.");
                }
                if (target.thinInstances) {
                    throw new Error("setMeshIndexedIndirect: unbind arguments before enabling thin instances.");
                }
            }
        });
    }
    // The existing epoch also invalidates independently owned/override task
    // bundles, whose draw closures consume the same mesh-local borrow.
    bumpVisibilityEpoch();
    for (const scene of _getMeshScenes(mesh) ?? []) {
        // A merged opaque packet can survive its replacement until deferred UBO
        // retirement. Stop that old draw now, without destroying in-flight resources.
        for (const dispose of scene._meshDisposables.get(mesh) ?? []) {
            const packet = (dispose as (() => void) & { p?: ShaderPacket }).p;
            if (packet) {
                packet._disposed = true;
            }
        }
        scene._renderableVersion++;
    }
    markMeshRenderableDirty(mesh);
}

/** Report physical index capacity and CPU-known counts without GPU readback. */
export function getMeshIndexedDrawInfo(mesh: Mesh): MeshIndexedDrawInfo {
    if (mesh._disposed) {
        throw new Error("getMeshIndexedDrawInfo: mesh has been disposed.");
    }
    if (mesh.thinInstances) {
        throw new Error("getMeshIndexedDrawInfo: only plain meshes without thin instances are supported.");
    }
    const indirect = borrows?.has(mesh) === true;
    return {
        mode: indirect ? "indirect" : "direct",
        indexCapacity: Math.floor(mesh._gpu.indexBuffer.size / (mesh._gpu.indexFormat === "uint16" ? 2 : 4)),
        indexCount: indirect ? null : mesh._gpu.indexCount,
        instanceCount: indirect ? null : 1,
    };
}
