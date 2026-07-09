/** Generic ref-counting for plain objects that carry an optional `_refCount` field.
 *
 *  Its one current use is GPU resource objects (`MeshGPU`, `SkeletonData`,
 *  `MorphTargetData`, `ThinInstanceData`) shared across mesh clones:
 *  `cloneTransformNode`/`cloneMeshNode` intentionally SHARE geometry (mesh._gpu),
 *  skeleton, morph-target, and thin-instance GPU buffers between a source mesh and
 *  its clone (mirrors BJS `Mesh.clone()` — cheap instancing, no duplicate GPU memory),
 *  so each of those resource objects may be referenced by more than one `Mesh`, and
 *  each declares its own optional `_refCount` field for this purpose (see each
 *  interface). Nothing here is mesh- or GPU-specific — any object type may add an
 *  optional `_refCount?: number` field and use `retain`/`release` on it.
 *
 *  `disposeMeshGpu` must only actually call `.destroy()` on the underlying GPUBuffers
 *  when the LAST owning mesh releases the resource — otherwise removing/disposing one
 *  mesh frees buffers a sibling clone still renders with (use-after-free), and disposing
 *  the sibling afterwards double-frees the same GPUBuffer.
 *
 *  A resource with `_refCount` left `undefined` is implicitly owned by exactly one
 *  owner (the common case — no clone was ever made), so creation sites don't need to
 *  initialize it. `retain` is called once per EXTRA owner (i.e. once per clone);
 *  `release` is called once per owner that goes away and reports whether it was the
 *  last one.
 *
 *  INVARIANT: any code path that reassigns one of these tracked fields away from its
 *  current value (e.g. `mesh.skeleton = null`) OUTSIDE of `disposeMeshGpu` MUST call
 *  `release` on the OLD value first — otherwise that owner's claim is silently
 *  dropped without ever being released, permanently pinning the refcount above zero and
 *  leaking the resource forever (no remaining owner can ever be seen as "last"). See
 *  `vat/vat-baker.ts::attachVat`, which drops `mesh.skeleton` when baking a VAT.
 *
 *  A second, related trap: code that REPLACES a resource wholesale (e.g. device-lost
 *  recovery rebuilding `mesh._gpu`) must build the replacement as a fresh object literal,
 *  never `{ ...oldResource, ...overrides }` — spreading would copy the OLD `_refCount`
 *  onto the new object, corrupting its ownership count. `Object.assign(old, rebuilt)` is
 *  fine (mutates `old` in place, preserving its real `_refCount`) as long as `rebuilt` is
 *  itself a fresh literal with no `_refCount` key of its own to stomp `old`'s value with. */

/** @internal Shape of any object trackable by `retain`/`release` — declares its own
 *  optional `_refCount` field so no separate side-table is needed. */
interface RefCounted {
    _refCount?: number;
}

/** @internal Register an additional owner of a shared resource (called when a mesh
 *  clone starts sharing `_gpu`/`skeleton`/`morphTargets`/`thinInstances` with its source). */
export function retain(resource: RefCounted): void {
    resource._refCount = (resource._refCount ?? 1) + 1;
}

/** @internal Release one owner's claim on a shared resource. Returns `true` when this
 *  was the last claim — the caller should now destroy the underlying GPU buffers. A
 *  resource that was never retained (never cloned) also returns `true` on its first (and
 *  only) release, since it has exactly one implicit owner. */
export function release(resource: RefCounted): boolean {
    const count = resource._refCount;
    if (count === undefined || count <= 1) {
        return true;
    }
    resource._refCount = count - 1;
    return false;
}
