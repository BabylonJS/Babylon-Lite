# Module: USD command-buffer loader

> Package path: `packages/babylon-lite/src/loader-usd/`

## Purpose

Load USD, USDA, USDC and USDZ using the same prebuilt OpenUSD WebAssembly
extractor as Babylon.js. There is no GLB or Babylon JSON intermediate and no
dependency on Babylon.js. The C++ implementation and protocol-v5 runtime are shared with Babylon.js from
https://github.com/BabylonJS/babylon-usd-importer. Lite does not fork or
recompile the extractor.

The loader creates ordinary Lite scene nodes, meshes and PBR materials. It
never mutates a scene: the caller owns `addToScene(scene, result)`. Public
results are plain state and operations are standalone functions.

## Public API surface

```typescript
loadUsd(engine: EngineContext, source: string | UsdBinaryInput,
        options?: LoadUsdOptions): Promise<UsdAssetContainer>;
disposeUsd(container: UsdAssetContainer): void;
```

`LoadUsdOptions` accepts `rootFileName`, a `files` map of relative virtual paths
to ArrayBuffer/ArrayBufferView/Blob data, `resolveByFileName` (default true),
`runtimeBaseUrl` (default
`https://cdn.babylonjs.com/babylonUsdImporter/5/`), an `AbortSignal`,
`onProgress` and `onLog`. The root name is inferred from URL/File names;
extensionless binary input is identified by USDZ ZIP or USDC crate magic.
Source buffers are copied before transferring, never detached from their owner.
Paths preserve case and directory structure; absolute paths and `..` are rejected.
Sidecars are explicitly supplied, never silently fetched from arbitrary URLs.

`UsdAssetContainer` extends `AssetContainer` with import diagnostics (worker
timings, statistics, missing assets and materialization duration) and internal
ownership state. `disposeUsd` releases the container's GPU resources
idempotently; remove it from any scenes first. It does not dispose the engine
or change scene-global material/texture caches.

## Internal architecture

### Worker boundary

Each load starts one module worker, posts an `extract` request with ID 1, and
terminates it after extraction or on any failure/cancellation. The shipped
worker stages files in its own Emscripten filesystem, opens the composed stage
(without flattening), and returns two transferable ArrayBuffers. Log/progress
events are forwarded. Worker exceptions and `messageerror` reject the load.
Cross-origin worker URLs use a revocable same-origin module bootstrap URL.

The default worker, JS glue, WASM and data files are the same immutable
protocol-v5 assets used by Babylon.js. They are runtime downloads, not imports
from Lite's root entry or inline JS assets. Applications may self-host the four
files together and set `runtimeBaseUrl`; mixing protocol versions rejects
before any GPU resources are allocated.

### Protocol

Little-endian command header: magic `0x42445355`, uint16 version 5,
uint16 reserved, uint32 command count, uint32 reserved (16 bytes total).
Each command has uint16 opcode, uint16 flags, uint32 payload length, then
its payload. Unknown versions/opcodes, incorrect payload lengths, truncation,
trailing bytes, invalid IDs and out-of-range/alignment references reject.
The missing-reference sentinel is `0xffffffff`. Strings are UTF-8 slices.
Numbers and matrices reference aligned spans of the raw-data buffer.

| Opcode           | Payload bytes | Contents                                                                                                        |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| 1 Scene          | 12            | Z-up flag, meters per unit, time codes per second                                                               |
| 2 Texture        | 48            | ID, name slice, MIME, image slice, UV set, UV transform, U/V wrapping, source color space and float4 scale/bias |
| 3 Material       | 96            | ID, name, factors and flags followed by seven independent texture IDs and output channels                       |
| 4 Node           | 20            | ID, parent ID, name slice, affine local matrix offset                                                           |
| 5 Skeleton       | 20            | ID, name, joint count and six-word joint-record offset (parent, bone ID, name, rest matrix, bind matrix)        |
| 6 Geometry       | 60            | ID, counts, flags, positions/normals/tangents/UV/colors, two skin streams, indices, influences                  |
| 7 Mesh           | 40            | ID, node, geometry, material, name, flags, skeleton, subset records                                             |
| 8 Instance       | 16            | Source mesh ID, placement node ID, name                                                                         |
| 9 Animation      | 32            | Target kind/ID/property, group, key count, time/value offsets, stride                                           |
| 10 Analytic      | 44            | ID, node, shape, material, name, flags, axis, radius/size, height, tessellation                                 |
| 11 ThinInstances | 12            | Source mesh ID, contiguous matrix offset and instance count                                                     |
| 12 MorphTarget   | 32            | ID, source mesh, name, vertex count, position/normal offsets and initial influence                              |

Read commands once into immutable records, then construct resource maps.
The core dispatches optional commands to lazily imported feature modules:
textures/material features, analytic geometry, classic instances, thin
instances, skeletons, morph targets and animation. Static untextured meshes do
not fetch those feature modules.

### Geometry and hierarchy

Node matrices use `createSceneNodeFromMatrix` to preserve shear. A synthetic
root applies meters-per-unit, USD Z-up rotation and right-to-left-handed
conversion exactly once. Meshes are identity children of placement nodes.
Bounds remain geometry-local. Winding is converted once into Lite's existing
CCW pipeline convention, not hidden by globally disabling culling.

Geometry arrays are typed views where possible. Single-material meshes take
the direct upload path. Material subsets become child meshes, using compact
indexed streams rather than uploading the entire source mesh for every subset.
Repeated placements share the same immutable MeshGPU and CPU streams with
Lite's existing retain/release ownership. Each placement retains its own
transform and name. Point-instancer batches attach the extractor's contiguous
float4x4 span directly with `setThinInstances`, producing one instanced draw per
prototype rather than one Lite mesh per point.

Analytic cube, sphere, cylinder and cone records use Lite's geometry builders;
axis correction is local to the shape, not applied to its children.

### Materials and textures

Create Lite PBR metallic/roughness props directly. Optional alpha testing,
emission, unlit and UV transforms go through their existing opt-in setters.
Image decoding is asynchronous, uses straight alpha and explicit source color
space, and closes decoded bitmaps. Texture objects are shared by protocol ID.
USD's seven independent Preview Surface bindings are represented by a
loader-owned PBR material plugin. The plugin samples each authored output
channel independently, applies its float4 scale/bias and UV transform, and
overrides base color, opacity, metallic, roughness, occlusion and emissive
values before lighting. Normal bindings apply their authored transform in
Lite's cotangent-frame normal path. Plugin registration occurs only when a
loaded USD material needs it, so non-USD and untextured USD scenes retain no
plugin bridge.

### Skinning and animation

Joint records store parent index, global protocol bone ID, name, local rest
matrix and local bind matrix. Parents precede children. The loader accumulates
the local bind hierarchy before inversion, so inverse bind matrices come from
the authored bind pose rather than being inferred from the rest pose; mesh skin
streams are retained through subset remapping.

Morph records contain absolute target positions/normals. The loader remaps them
through each compact material subset, converts them to Lite deltas and creates
the existing storage-buffer-backed `MorphTargetData`. There is no fixed target
count. Classic instances retain the source skeleton and morph buffers; point
instances retain them on the prototype draw.

Animation modules convert time codes to seconds, preserve target IDs and local
affine matrices, and return ordinary AnimationGroups. Morph influence tracks
write individual entries in the shared weights buffer. Groups are not
automatically played by the loader.

## Pipeline configuration and shader logic

No USD-specific renderer or pipeline family is introduced. Lite's existing
PBR, skinning, morph and instancing builders own pipeline creation. Textured
Preview Surface materials attach a loader-owned `MaterialPlugin`; its generated
WGSL samples only the authored channels and its signature participates in the
existing material pipeline cache. Untextured USD assets load no plugin bridge
or plugin shader code.

## State machine / lifecycle

Fetch/stage -> worker extraction -> validate commands -> materialize -> return.
Every asynchronous boundary observes cancellation. On abort or error, terminate
the worker, revoke bootstrap/image URLs, close decoded images, and release all
partially created meshes, skin resources and textures. Late decode completion
must release its result rather than attach resources to an abandoned load.
Successful results transfer ownership to the caller.

## Babylon.js equivalence map

TransformNode -> Lite SceneNode with raw matrix; Mesh/InstancedMesh -> distinct
Lite Mesh nodes with shared geometry; MultiMaterial/SubMesh -> child Mesh per
material subset; PBRMaterial -> native PbrMaterialProps; Skeleton/AnimationGroup
-> native Lite skeleton data and animation groups. No Babylon.js TypeScript
classes or scene registration machinery are copied.

## Dependencies

Existing Lite scene, mesh, PBR, texture, math and resource helpers. Optional
feature modules depend on their matching Lite subsystems. OpenUSD binaries are
external runtime assets with their original license notices. No new runtime
package dependency or package subpath export is required.

## Test specification

Unit tests cover command validation, typed-array bounds, hierarchy/units/up-axis,
winding, material subsets, independent material channels, shared geometry and
ownership, analytic shapes, thin instances, bind/rest skeletons, morph targets
and influence animation, cancellation and virtual file sets. Browser plumbing
tests use the real shared worker with public synthetic USDA, USDC and USDZ
fixtures.

A paired lab scene loads the same point-instanced USD through Babylon.js and
Lite. Its machine-readable counters assert semantic parity (source meshes,
instances and triangles), while the existing Lite-vs-Babylon.js RAF benchmark
collects initialization time, frame cost, draw calls and JS heap usage for the
same scene. The comparison is additive: it does not alter existing image
goldens, MAD thresholds or bundle ceilings. Root-entry build tests prove
unrelated imports do not retain the USD loader or external runtime.

## File manifest

`load-usd.ts` (public entry and lifetime), `usd-types.ts` (public state),
`usd-worker-client.ts` (extraction transport), `usd-protocol.ts` (checked binary
reader), `usd-materialize.ts` (core scene assembly), optional `usd-*.ts` feature
modules, unit tests under `tests/lite/unit/`, browser comparison tests under
`tests/lite/plumbing/`, and paired lab scenes under `lab/lite/src/`.
