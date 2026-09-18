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

`StorageBuffer` is nominally branded plain state containing a public aligned byte capacity and an
internal `GPUBuffer`. Plain read-only storage retains a CPU shadow and uses a mapped-at-creation
`STORAGE | COPY_DST` allocation. Writable, vertex, index, and indirect allocations retain no CPU
shadow; writable allocations also add `COPY_SRC`. Numeric GPU-role sources allocate directly on
the GPU. Typed GPU-role sources use mapped-at-creation initialization, copying just the
view's bytes into the padded, zero-initialized allocation. Odd byte counts therefore do not reach
`queue.writeBuffer`, whose upload length must be a multiple of four.
Optional vertex/index/indirect usage flags describe the allocation's capabilities. Updates use
`queue.writeBuffer` and require four-byte-aligned offsets and lengths. The shader material stores the resource
object; the renderable unwraps the internal handle only while building a bind group.
Internal identity/lifecycle fields are non-enumerable, and every mutating/binding path verifies that the exact
wrapper remains registered with its owning engine; shallow copies cannot impersonate a live allocation.

The engine owns a lazy set of live storage buffers. Its pre-existing CPU-backed storage
rebuild restores plain read-only `STORAGE | COPY_DST` allocations from retained bytes.
The old device's storage limits are requested again for that path. The limit collection and
rebuild routine stay in the recovery-only module so ordinary storage users do not load
restoration code or create recovery callbacks.
Recovery loads this module only when storage allocations exist. It checks again after the
replacement-device request so an allocation added during that await is not missed.
Bind-group creation rechecks resource liveness and engine ownership. Engine disposal destroys
all remaining live storage buffers, releases CPU bytes, and clears the registry.

Automatic recovery of GPU-role storage allocations and storage-backed meshes is deliberately deferred
to the upcoming recovery redesign. These allocations have no CPU mirror and are not
reallocated or refilled by the existing hook. Storage meshes retain no reconstruction source
or weak registration, and their borrowed handles and privately owned index buffers are not
rebound or recreated after device loss. Applications using these features must recreate the
affected allocations and meshes before rendering resumes. The legacy plain-storage rebuild
does not cover these newer roles or repair an existing storage mesh.

## Pipeline Configuration

The module creates no pipelines. Shader-material storage declarations continue to create read-only-storage bind-group-layout entries. Rebinding the same resource is a no-op, while binding a different resource increments the material resource version once.

### Storage-backed mesh layout boundaries

Storage meshes and interleaved glTF meshes publish a null-prototype layout dictionary keyed
by attribute name (`position`, `normal`, `uv`, `uv2`, `tangent`, `color`). Materials read
packing directly while emitting GPU layouts; no global activation or name-to-slot
translation is needed. Unknown names cannot resolve through `Object.prototype`.
Material attributes and WGSL types are unchanged; instance-rate attributes retain their
material-defined packing. The glTF decoder's CPU accessor records keep their own representation.

Node emits canonical and packed GPU layouts through the same attribute loop. Resolution
happens when binding, not when the material is parsed, so a material compiled before its
first storage mesh still acquires the correct variant. Variants belong to their compile
result and never cross devices. Opaque Node grouping checks for heterogeneous layout keys
before allocating a partition map; geometry creation never imports or installs a Node backend.
Packing variants reuse the base descriptor's pipeline layout, shader modules, and fragment
state; only their vertex-buffer layouts change. This also applies to geometry MRT output.
The compile result retains its original `UboSpec` rather than parallel size/offset metadata;
graphs without node uniforms retain no empty layout map.

The mesh's layout includes zero-stride entries for absent tangent, UV2, and color streams.
Those entries describe the constant fallback buffer, not the slab. Their cache-key slots
remain `-`, distinct from an authored slab attribute at offset zero. Materials therefore
need no second layout rewrite to support missing streams.

`MeshFromStorageOptions.attributeOffsets` accepts only own properties for position, normal,
UV, UV2, tangent, and color. Unknown names (including skinning streams), non-integer or negative
offsets, offsets outside the vertex stride, and strides above the device limit are rejected
before index-buffer allocation. Material preparation additionally validates each consumed
format's byte extent and alignment; a material declaration never repacks canonical CPU geometry.

Direct draws pass `baseVertex` to WebGPU without a forwarding wrapper. The five-word
indirect ABI is shared in `mesh-indexed-indirect.ts`, loaded only by indirect consumers.
Drawing a mesh must not import attribute conversion or default-stream allocation. Shared
zero-stream allocation remains installed only by storage geometry, as an engine-owned
`_getVertexDefaultBuffer` callback. Its closure owns the current device/buffer pair, replaces
the buffer after a device change, and registers exactly one disposer per live generation.
Core renderers contain only an optional callback invocation, not a global default-buffer registry.
Legacy Node/Shader missing-attribute buffers use the interleaved position accessor's element
count before considering a tightly packed float32x3 buffer-size heuristic. Empty geometry
keeps a valid four-byte minimum. Storage-backed meshes still take the constant-buffer path
first and never allocate defaults proportional to the shared slab.

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
If mapped-range extraction or copying fails, staging is still unmapped before reuse and the
read promise preserves the failure. Updates to writable buffers create no CPU shadow views.

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
- `packages/babylon-lite/src/resource/storage-buffer-recovery.ts`: pre-existing plain-storage restoration only.
- `tests/lite/unit/storage-buffer.test.ts`
- `docs/lite/architecture/47-storage-buffer.md`
