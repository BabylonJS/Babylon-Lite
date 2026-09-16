# Module: Storage Buffer

> Package path: `packages/babylon-lite/src/resource/storage-buffer.ts`

## Purpose

Expose shader-readable storage allocations without exposing raw WebGPU handles in the public API. The resource has stable identity so its contents can change without rebuilding material bind groups.

## Public API Surface

```ts
interface StorageBuffer {
    readonly byteLength: number;
}

interface StorageBufferOptions {
    readonly label?: string;
    readonly writable?: boolean;
    readonly vertex?: boolean;
    readonly index?: boolean;
    readonly indirect?: boolean;
}

function createStorageBuffer(engine: EngineContext, source: ArrayBufferView | number, labelOrOptions?: string | StorageBufferOptions): StorageBuffer;
function updateStorageBuffer(engine: EngineContext, buffer: StorageBuffer, data: ArrayBufferView, byteOffset?: number): void;
function readStorageBuffer(buffer: StorageBuffer): Promise<ArrayBuffer>;
function disposeStorageBuffer(buffer: StorageBuffer): void;
```

`setShaderStorageBuffer(material, name, buffer)` accepts `StorageBuffer | null` for a storage declaration created by `createShaderMaterial`.

This replaces the previous raw `GPUBuffer` parameter. Migrate by wrapping initial data with
`createStorageBuffer`, updating it through `updateStorageBuffer`, and unbinding it before
`disposeStorageBuffer`.

Numeric sources specify a finite, non-negative safe integer byte count. Zero remains valid
and reserves the minimum four-byte allocation. Both numeric and typed-view sources are rounded
up with `Math.ceil(Math.max(requestedBytes, 4) / 4) * 4`, never 32-bit bitwise arithmetic.
The padded capacity must remain a safe integer and must not exceed `device.limits.maxBufferSize`;
validation happens before creating a CPU shadow, allocating GPU memory, or registering the resource.
For typed views, the view's byte length and offset apply, not the full backing buffer.

## Internal Architecture

`StorageBuffer` is nominally branded plain state containing a public aligned byte capacity, retained CPU bytes,
and an internal `GPUBuffer`. Read-only creation uses a mapped-at-creation `STORAGE | COPY_DST` allocation.
Writable allocations retain no CPU shadow and add `COPY_SRC`; numeric writable sources allocate
directly on the GPU. Typed writable sources use mapped-at-creation initialization, copying just the
view's bytes into the padded, zero-initialized allocation. Odd byte counts therefore do not reach
`queue.writeBuffer`, whose upload length must be a multiple of four.
Optional vertex/index/indirect usage flags are retained for recovery. Updates use
`queue.writeBuffer` and require four-byte-aligned offsets and lengths. The shader material stores the resource
object; the renderable unwraps the internal handle only while building a bind group.
Internal identity/lifecycle fields are non-enumerable, and every mutating/binding path verifies that the exact
wrapper remains registered with its owning engine; shallow copies cannot impersonate a live allocation.

The engine owns a lazy set of live storage buffers. Device-loss recovery recreates read-only handles from
their retained CPU bytes; writable allocations are recreated empty with the same role flags and must
be refilled by their producer. `COPY_DST` is added on both allocation paths. Storage-backed meshes
refresh their borrowed handles before scene renderables and bind groups are rebuilt. Bind-group creation rechecks
resource liveness and engine ownership. Engine disposal destroys all remaining live storage buffers, marks
their wrappers disposed, releases retained CPU bytes, and clears the lazy registry.
When the first storage buffer is created, the engine also retains its current storage-related WebGPU limits
(`maxBufferSize`, `maxStorageBufferBindingSize`, and `maxStorageBuffersPerShaderStage`) and requests them
again during device recovery. Those values are merged with any limits originally supplied to
`createEngine(..., { requiredLimits })`.

## Pipeline Configuration

The module creates no pipelines. Shader-material storage declarations continue to create read-only-storage bind-group-layout entries. Rebinding the same resource is a no-op, while binding a different resource increments the material resource version once.

## Shader Logic

None. The declaration's WGSL type remains owned by `ShaderStorageBufferDecl`.

## State Machine / Lifecycle

Create, optionally update any in-bounds range, bind to one or more shader materials, unbind, then dispose.
Disposal is idempotent. Updating or rebinding a disposed resource throws; a zero-length in-bounds update is a no-op.

`readStorageBuffer` rejects while the owning engine has an active frame encoder, before staging
allocation or submission. Read after the producing frame has been submitted; an independent copy
must never overtake compute writes already recorded into that frame.
Only writable allocations support readback. Concurrent reads share the pending promise and reuse a
lazy staging buffer; each completed read returns an independent `ArrayBuffer` copy. A device change
is rejected while a read is pending, and later reads replace staging allocated on an older device.

## Babylon.js Equivalence Map

Equivalent in role to Babylon.js `StorageBuffer`: a high-level lifetime wrapper around a WebGPU storage allocation, with standalone functions matching Lite's pure-state API convention.

## Dependencies

`EngineContext`, internal GPU flag aliases, and the internal mapped-buffer upload helper.

## Test Specification

Unit tests verify creation flags and alignment, initial mapped upload, bounded aligned updates, hidden handle identity, idempotent disposal, and rejection of use after disposal.
Size coverage includes negative/fractional/non-finite/unsafe values, zero and odd byte counts,
padded device-limit boundaries, typed subarrays, and values crossing 2 GiB/4 GiB without large
host allocations. The shared alignment helper is exercised at those boundaries too.

## File Manifest

- `packages/babylon-lite/src/resource/storage-buffer.ts`
- `tests/lite/unit/storage-buffer.test.ts`
- `docs/lite/architecture/47-storage-buffer.md`
