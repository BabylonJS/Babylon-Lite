# Module: Sprite2D instance parameters

> Package path: `packages/babylon-lite/src/sprite/`
>
> Additive extension to [Sprites](32-sprites.md). Ordinary sprite layers retain
> their existing layout, shader, buffers, batching and upload behavior.

## Purpose

Transport four application-defined Float32 values from each sprite to its custom
fragment shader without reinterpreting color, UV coordinates or NDC depth. A
presentation-height offset is one possible use; the engine does not interpret
these values or change sprite geometry.

## Public API Surface

All exports are available from the single `@babylonjs/lite` root entry point:

```typescript
type Sprite2DInstanceParams = readonly [number, number, number, number] | Float32Array;

function enableSprite2DInstanceParams(layer: Sprite2DLayer): void;
function setSprite2DInstanceParamsIndex(layer: Sprite2DLayer, index: number, params: Sprite2DInstanceParams): void;
function setSprite2DInstanceParams(handle: Sprite2DHandle, params: Sprite2DInstanceParams): void;
```

Enable explicitly during setup, after creating a layer with `customShader` and
before rendering its fragment's first use of `in.instanceParams`. For depth-hosted
layers, enable before `addDepthHostedSpriteLayer`; changing their layout after
registration is unsupported because their draw bindings cache the pipeline.
Only the pure-2D `SpriteRenderer` supports enabling after earlier frames.
Enabling a non-custom layer or a layer with a different vertex extension throws.
Repeated calls for this extension are idempotent. Existing and new instances
receive `[0, 0, 0, 0]`.

Setters require an enabled layer, a live integer index (or a live stable handle),
exactly four components, and values finite after Float32 conversion. Invalid
arguments throw before modifying instance data or dirty state. Setters copy the
components into owned storage; later caller mutations have no effect until
another setter call. A reusable tuple or four-element Float32Array avoids caller
allocations. The setter itself creates no arrays, views, objects or closures.

Normal `updateSprite2DIndex`, handle updates and frame/visibility changes preserve
the parameters. Use the parameter setter separately when they change. Neither
`Sprite2DProps` nor the existing layer-wide `fx.params` changes meaning.

## Internal Architecture

The tree-shakable `sprite-2d-instance-params.ts` enabler owns all parameter
semantics, validation, attribute construction and WGSL extension text.

The optional internal `layer._vertexExtension` is absent on ordinary layers.
It contains an owner identity, separate pipeline and shader keys, one precomputed
`GPUVertexAttribute`, vertex input/output/assignment text, and an
instance-initialization callback. This module uses its enabler function as the
owner identity: enable and setters reject a descriptor owned by another extension,
before changing data, layout or dirty state. Core code
only consumes this data or calls the optional callback on insertion. Public
declaration trimming removes the internal descriptor and all GPU types.

An optional shared `sprite-2d-instance-layout.ts` helper appends floats to instance
records. It is imported only by the UV-scroll and parameter enablers, not by core
modules. It allocates one capacity-sized staging array, copies existing complete
records at the new stride, updates the internal float/byte strides, and marks
all live records dirty. It returns the original stride as the appended offset.

Parameters append four floats (16 bytes) to each record. Attribute location 8 is
reserved for this vec4. Depth Z remains at float 13 / location 6; UV scroll remains
at location 7 and uses its precomputed attribute offset rather than assuming a
fixed tail position. The two enablers work in either order and preserve each
other's existing values.

| Layout                               | Floats | Bytes |
| ------------------------------------ | -----: | ----: |
| Pure 2D, ordinary                    |     13 |    52 |
| Depth-hosted, ordinary               |     14 |    56 |
| Pure 2D, parameters                  |     17 |    68 |
| Depth-hosted, parameters             |     18 |    72 |
| Pure 2D, parameters + UV scroll      |     19 |    76 |
| Depth-hosted, parameters + UV scroll |     20 |    80 |

The initialization callback zeros the new sprite's four slots, including reused
tail slots after swap-remove or clear/refill. Capacity growth copies complete
records. Swap-remove copies the whole last record, preserving parameter identity.
Stable handles resolve the current index before invoking the index setter.

## Pipeline Configuration

Keep the existing instance vertex buffer, indexed quad draw and bind groups.
There is no new draw, buffer binding, texture or UBO. The sprite FX hook supplies
the optional precomputed attribute to the existing pipeline builder; the
ordinary pipeline has no extra attribute.

The custom pipeline key incorporates the opaque extension key, including the
attribute offset. The per-device shader module key uses the extension's shader
identity, not its buffer offset: both UV enable orders share identical WGSL and
therefore share a shader module, while retaining separate pipelines. Depth,
UV-scroll and extension shader permutations remain distinct. Layer-wide shader
descriptors may be shared without mutating the descriptor.

Both paths grow GPU buffers by required byte size and upload full records after
reallocation. The pure-2D SpriteRenderer resolves its pipeline each frame, so late
enablement replaces the buffer and pipeline and re-records its render bundle.
Depth-hosted bindings resolve their pipeline only when the frame graph rebuilds;
enable both layout extensions during setup before adding the layer to the scene.
No renderer-specific parameter branch or new depth-hosted invalidation is added.

## Shader Logic

The shared prologue accepts opaque extension text, without parsing emitted WGSL.
The enabler supplies:

```wgsl
// Vertex input I
@location(8) instanceParams: vec4f
// Vertex output / fragment input O
@location(2) @interpolate(flat) instanceParams: vec4f,
// Vertex body
out.instanceParams = in.instanceParams;
```

The custom fragment reads `in.instanceParams`. Every corner receives the same
per-instance vec4, and the flat qualifier makes the no-interpolation contract
explicit. Existing `in.uv`, `in.tint`, `fx`, `L`, atlas and extra-texture bindings
are unchanged. Parameters do not encode or alter UV scrolling.

## State Machine / Lifecycle

1. Layer creation: the ordinary record layout and no descriptor.
2. Explicit enable: validate custom shader, append four zeroed floats, install
   descriptor once, force the next full upload and pipeline permutation.
3. Insert: reset parameters to zero without allocating.
4. Parameter update: validate atomically, write four Float32 values, mark one
   logical record dirty through `_markSprite2DDirty`.
5. Ordinary updates: preserve the extra slots.
6. Swap-remove: copy complete records; next insertion resets the reused slot.
7. Clear/refill: preserve capacity and descriptor, reset each inserted record.
8. Growth or UV enable: preserve full records and precomputed attribute offsets.
9. Y-sort: existing packing copies complete records and maps logical dirty
   ranges to draw order; parameters follow their owning sprite.
10. Device recovery/disposal: existing instance-buffer lifecycle is sufficient.
    Recovery uses retained CPU data and fresh per-device pipeline/module caches;
    disposal destroys the same existing buffer, with no extra GPU resource.

Uploads remain bounded to dirty records. Each opted-in uploaded record is
16 bytes wider; unchanged frames do not upload instance data. Memory growth is
exactly `capacity * 16` staging bytes plus the corresponding GPU vertex storage,
with the same existing doubling policy on capacity growth. Do not claim timing
improvements or zero measured overhead without qualified performance evidence.

## Babylon.js Equivalence Map

No Babylon.js sprite color/depth convention is repurposed. This is an additive
Lite custom-fragment input, not a new transform, animation system or height
interpretation.

## Dependencies

Sprite2D state/dirty helpers, typed-array aliases, existing custom shader/FX
hooks, existing WGSL composer, optional stable-handle index resolution.
No scene back-reference, import-time registry mutation or GPU allocation.

## Test Specification

- Pure 2D and both depth modes: unchanged ordinary strides; exact opted-in
  strides, offsets, zero defaults and Float32 values.
- Preserve color/UV/Z through enable, update, frame/visibility edits, growth,
  swap-remove, tail reuse and clear/refill.
- UV scroll enabled before or after parameters; independent values and correct
  attributes in both orders.
- Handle swap-remove and stale-handle errors; Y-sort packed identity.
- Atomic validation failures; repeated setters reuse storage with no typed-array
  allocation/view creation; bounded dirty uploads and no unchanged-frame upload.
- Reject foreign vertex-extension ownership without layout/data/dirty mutation.
- Distinct pipelines but shared modules for identical WGSL across UV enable orders;
  location 8 vec4, flat location 2 varying; device-keyed recompilation.
- Pure-2D late enablement: capacity-sized 68-byte records replace the old buffer,
  switch pipelines and re-record the render bundle without steady-state churn.
- CI GPU witness: two non-black instances with identical non-white RGBA/UV and
  different vec4 values produce expected pixels. UV contributes to a pixel channel,
  so its attribute offset is observable in both enable orders. Missing the first
  instance, zeroing parameters, using tint as parameters or misaddressing UV must
  independently break the witness.
- Focused bundle ceilings and absence of the enabler in ordinary scenes.
- Qualified CI/user performance evidence for allocation, dirty bytes and buffer
  size. Agents do not run local performance or visual/parity campaigns.

`tests/lite/parity/regressions/sprite-instance-params.spec.ts` executes the
production pipeline builder, instance-buffer widening and dirty uploader on a
real WebGPU device. It reads an offscreen RGBA8 render target directly, without
screenshots or new goldens, for all three depth modes and all three UV enable
orders (none, before parameters, after parameters). Identical non-white tint/UV
instances carry distinct, non-black vec4 values. The fragment adds weighted UV to
the blue channel; opaque blending preserves all four output channels. Independent
pixel-center calculations verify two samples per quad. Counterfactuals zero the
varying, fetch tint as parameters, omit the first instance, or fetch parameters as
UV. Each must change the pixels without GPU validation errors.

The same CI witness measures exact CPU/GPU buffer sizes, full versus coalesced
single-record dirty writes, and no writes on unchanged frames. It instruments
the Float32 constructor **before** importing the engine (so its captured `F32`
alias is measured), counts `subarray` views, and records 50,000 reusable-input
setter calls. New arrays/views are hard failures. Elapsed time is attached as
qualification evidence, not an arbitrary machine-sensitive timing ceiling.
Ordinary-scene performance remains covered by the existing CI regression job.
The cloud parity configuration always selects this witness, including when its
scene filter is active. It is not run locally by agents.

## File Manifest

- `sprite-2d-instance-params.ts`: enabler, public setters, validation, WGSL data.
- `sprite-2d-instance-layout.ts`: shared optional record widening.
- `sprite-2d.ts`: internal descriptor and opaque insertion seam.
- `sprite-fx-hook.ts`: erased descriptor type and attribute hook signature.
- `sprite-custom-shader.ts`: descriptor-aware composition and cache keys.
- `sprite-pipeline.ts`: opaque prologue text and attribute consumption.
- `sprite-2d-uvscroll.ts`: shared widening and attribute-based offset addressing.
- `index.ts`: explicit public root exports.
- `tests/lite/unit/sprite-2d-instance-params.test.ts`: lifecycle, validation,
  ownership, UV composition, Y-sort, allocation/view and dirty-upload checks.
- `tests/lite/unit/sprite-renderer.test.ts`: pipeline/module permutations.
- `tests/lite/unit/device-lost-renderer-recovery.test.ts`: retained parameter
  state and extended shader rebuild on a replacement device.
- `tests/lite/build/public-api-types.test.ts`: trimmed root declarations.
- `tests/lite/parity/regressions/sprite-instance-params.spec.ts`: real GPU
  witnesses, transport mutants, exact memory/upload and setter cost evidence.
- `config/playwright.parity-cloud.config.ts`: CI witness selection.
