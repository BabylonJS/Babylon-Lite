# Module: Plain storage mesh indexed indirect draw

## Purpose and public API

```ts
function setMeshIndexedIndirect(mesh: Mesh, buffer: StorageBuffer | null, byteOffset?: number): void;
interface MeshIndexedDrawInfo {
    readonly mode: "direct" | "indirect";
    readonly indexCapacity: number;
    readonly indexCount: number | null;
    readonly instanceCount: number | null;
}
function getMeshIndexedDrawInfo(mesh: Mesh): MeshIndexedDrawInfo;
```

An opt-in, mesh-local borrow for ordinary storage-backed ShaderMaterial meshes.
Create arguments with `createStorageBuffer(engine, 20, { writable: true, indirect: true })`.
Bind them with `setMeshIndexedIndirect(mesh, args, byteOffset)`. Passing null restores
the existing CPU draw. Thin instances and other material families are not supported.
Clones share geometry ownership as before but do not inherit this borrow; bind each
clone explicitly if it should consume the same arguments.

## ABI and producer contract

The source range is exactly 20 bytes, aligned to four bytes:
`u32 indexCount`, `u32 instanceCount`, `u32 firstIndex`, `i32 baseVertex`,
`u32 firstInstance`. The producer owns all five words, including signed baseVertex
and the exact firstIndex. Lite never initializes, reads, copies, or patches them.
Zero GPU count is a valid no-op. The producer must keep index and vertex accesses
within the initialized geometry and set firstInstance to zero unless the device
supports `indirect-first-instance`. Binding validates the byte range, not GPU values.

Submit compute before the consuming render pass using Lite's compute API. The
same buffer can be a compute storage binding and an indirect argument source,
but must not be writable storage in the consuming render pass (WebGPU usage conflict).
Analytic mesh bounds must encompass every generated draw; CPU picking and CPU
admission are not reconstructed from GPU data.

## Ownership, replacement, and recovery

Arguments, borrowed vertices, and shared indices remain caller-owned.
Binding stores an external WeakMap entry, not a scene reference on Mesh.
Unbinding/replacement releases the old borrow; retirement deletes it without
destroying the allocation. Non-disposing scene detach preserves the borrow.
Dispose only after all consumers and submitted work have finished using the resource.
Disposing a still-bound allocation is an error on the next update/draw, including
the update preceding cached-bundle execution; there is no CPU-count fallback.

Binding validates registration, engine/device identity, INDIRECT usage, safe
nonnegative four-byte offset, and `offset + 20 <= byteLength`, before mutation.
The storage geometry must still refer to live vertex/index allocations on the
same device. Replacement/unbind queues each subscribed scene's normal rebuild
and invalidates its bundles. Retiring old merged Shader packets must stop their
draw immediately, while UBO/texture destruction uses normal deferred retirement.
The existing visibility/resource epoch also invalidates independently owned task
bundles, including material-override tasks. Argument replacement does not require
`enableRenderTaskMeshRefresh`; that policy still applies to unrelated geometry/material changes.
Unbind before switching to a different material family or enabling thin instances.
Do not mutate a borrow while a frame encoder is active.

Plain read-only storage recovery rebuilds its handle from the CPU shadow. GPU-role
storage has no CPU shadow; recovery clears its old-device handle, so every bind path
(compute, ShaderMaterial storage, vertex/index/indirect consumers) rejects it explicitly. After device loss, recreate the vertex,
index, and indirect allocations and storage mesh on the replacement device,
rebind compute and draw consumers, and rerun the producer before rendering.
Rebinding an old GPU-role allocation cannot make its data valid on a new device.

## Rendering and diagnostics

An optional Shader draw/update resolver is installed only by the binding API.
Unused consumers retain the existing `drawIndexed(indexCount, 1, firstIndex, baseVertex)`.
Indirect consumers record `drawIndexedIndirect(handle, byteOffset)` in the same
packet position, pipeline, transparent sorting, camera, and pass as direct consumers.
GPU-only contents can change without re-recording a bundle; binding identity/offset
changes trigger rebuilds. CPU diagnostics report physical index capacity and null
GPU index/instance counts, never capacity as admitted/submitted geometry. Existing
draw-call counters count recorded draw commands, not nonzero GPU admission.

## Test specification and files

Unit regression: `tests/lite/unit/mesh-indexed-indirect.test.ts`, including exact
range forwarding, no argument writes, default restoration, invalid input, scene
invalidation, caller ownership, clones, detach, retirement, and recovery rejection.
Native acceptance must dispatch compute into the argument allocation and observe
changed rendered pixels without reading argument bytes or changing CPU indexCount.
Root API declarations and tree-shaking tests cover the public entry and opt-in seam.

Implementation: `packages/babylon-lite/src/mesh/mesh-indexed-indirect-borrow.ts` (kept apart from
the `mesh-indexed-indirect.ts` ABI writer, which thin-instance paths import statically);
Shader resolver seam: `material/shader/shader-renderable.ts`;
old-device rejection: `resource/storage-buffer-recovery.ts` and `resource/storage-buffer.ts`;
retirement seam: `mesh/mesh-dispose.ts`; scene invalidation:
`scene/mesh-scene-registry.ts`.
