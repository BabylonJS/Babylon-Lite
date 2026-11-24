# Lite GL for Babylon Native

> Source path: `packages/babylon-lite-gl/src/native/`
> Public entry: `@babylonjs/lite-gl/native`
> Status: **experimental and temporary**, implemented as a subpath of the existing `@babylonjs/lite-gl` package.

This backend is a temporary implementation for evaluation, not a stable API
or a long-term backend commitment. Its API and implementation may change,
be replaced, or be removed.

This entry renders Lite GL-style composition through the Babylon Native engine
protocol instead of a browser `WebGL2RenderingContext`. It is not a WebGPU
renderer, a scene graph, or a Babylon.js engine-class compatibility layer.

## 1. Packaging

The native backend is a second public entry of `@babylonjs/lite-gl`, not a
separate package. The source manifest maps `./native` to
`src/native/index.ts`; `build.mjs` emits `dist/native/*.js` and trimmed
declarations next to the web entry, and the generated `dist/package.json`
exports both:

```json
{
    ".": { "import": "./index.js", "types": "./index.d.ts" },
    "./native": { "import": "./native/index.js", "types": "./native/index.d.ts" },
    "./family": { "import": "./family.js", "types": "./family.d.ts" }
}
```

The two backend entries are independent module graphs. The web barrel never imports
`native/`, and `native/` never imports the WebGL modules, so each consumer's
bundle contains only the backend it imports. `native/` imports only the
type-only backend contract (`../family.ts`), which emits no runtime code and
references no DOM type. Neither entry has import-time
side effects: the native runtime (`globalThis._native`) is read only when an
engine is created. Relative imports keep explicit `.js` extensions, so the
emitted files are runnable ESM without a bundler.

Shared consumer code is written once against the backend family
(`04-backend-family.md`): it receives a `GLKit` of the operations it uses, and
each composition root fills the kit with direct references to one backend's
exported functions. There are no build aliases, runtime facades, or
`ThinEngine`, `ThinTexture`, or `Effect` lookalikes.

The native entry implements a subset of the backend-neutral operations, with
the same `GL*` type names (`GLEngineContext`, `GLEffect`, `GLTexture`,
`GLRenderTarget`, `GLMeshVao`, …) and option objects, including the receiver
rule: operations on an existing resource take the resource first and derive
its engine from it. `NativeGLFamily` records where its signatures are narrower
than the web backend's, such as non-instanced draws, immutable vertex buffers,
RGBA8 raw uploads and samplers that cannot be unbound with `null`.
`NativeGLHostOps` lists the native-specific engine creation and borrowed host
texture operations.

## 2. Contract

Public handles are pure state; standalone functions own engine creation,
effects, buffers, sampled textures, render targets, and drawing. The caller
supplies GLSL ES 3.00 shaders and explicit attribute, uniform, and sampler names,
as with Lite GL. Shader includes and any host-specific shader preparation belong
to the caller, not to the native command encoder. A `#version` line preceded
only by whitespace and comments is dropped because the native compiler takes
unversioned GLSL; any `defines` lead the source sent to the native compiler.

Every native resource type carries a type-only identity of its backend and
kind. It survives the trimmed published declarations, so a web resource, a
different kind of native resource, or an object with matching public fields is
not accepted where a native resource is expected. Resources never store it at
runtime.

### 2.1 Engine and frames

`createNativeEngine()` requires Babylon Native engine protocol 9 and creates
one native engine and one reusable 64 KiB command stream. It sets hardware
scaling to one and disables depth test, depth writes, and culling for
composition. As in Lite GL, `getRenderWidth` / `getRenderHeight` report the
native output size, `getCurrentRenderTarget` reports the bound target, and
`engine.caps.maxTextureSize` reports the device texture limit; texture and
render-target sizes must be positive integers within it and are rejected before
any host allocation. The host reads this limit once, when its engine class is
defined, and reports 0 if its graphics device has not started yet. Lite GL
treats 0 as an unknown limit and then rejects only sizes that are not positive
integers, leaving larger sizes to the host.

`beginFrame(engine)` and `endFrame(engine)` bracket command submission;
`endFrame` submits the remaining commands, including a partially encoded frame
being unwound after a caller error. Resource operations outside a frame submit
immediately. Nested or unmatched frame scopes are errors. A command that cannot
fit in the stream, such as an oversized uniform array, is rejected before any of
it is recorded, so the stream and the uniform cache are unchanged. Array values
are read once, before recording, so an array whose read throws leaves them
unchanged too, and a read that disposes the effect or engine leaves the upload
unrecorded.

`disposeNativeEngine(engine)` is idempotent and disposes the native engine.

### 2.2 Effects

`createEffect(engine, options)` compiles the supplied source and resolves all
declared names once and throws on failure, so `isEffectReady` is true until
disposal and `getEffectCompilationError` always returns `null`. Each effect owns
its program and a value cache. Uniform
setters bind that program before uploading, ignore undeclared or absent uniforms,
and skip unchanged values. Unlike Lite GL, native does not resolve undeclared
uniform names. Every setter for a given uniform name shares one numeric value
cache, so scalar, integer, vector, and array setters elide against each other;
array setters compare values rather than array identity. Uniform data belongs to each native program.

Texture slots belong to the frame encoder instead: sampler bindings are reused
only within the same frame and program run, and are rebound after a program
switch or a new frame. `setEffectTexture` ignores a name that is not a declared
sampler, before selecting any program. `useEffect` and indexed drawing share the
engine's program and vertex-array caches. As in Lite GL, operations on a
disposed effect, texture, vertex array, render target or engine are ignored;
disposing a resource after its engine only marks it disposed. Binding a texture
of another engine is ignored, while `createMeshVao` and `createRenderTarget`
reject an effect, buffer or color texture that belongs to another engine or has
been disposed, before any host call. `disposeEffect` releases only the program.

### 2.3 Buffers and vertex arrays

`createVertexBuffer(engine, data: Float32Array)` and
`createIndexBuffer(engine, data: Uint16Array | Uint32Array)` own native storage.
`disposeBuffer(buffer)` releases either kind idempotently.

`createMeshVao(engine, vertexBuffers, indexBuffer, effect)` records immutable
geometry once. Each vertex-buffer descriptor has `buffer`, `attributes`, and
optional `computeStride`, as in Lite GL. Attributes specify `name`, `size`,
optional byte `offset`, and `divisor: 0`; as in Lite GL, an omitted divisor
would mean instanced data, so per-vertex attributes state it explicitly. With
`computeStride`, stride is the sum of component widths; otherwise attributes
are tightly packed. Only float, non-instanced geometry is supported. Attribute
locations come from the supplied effect; names it did not declare are resolved
from its program once, when the vertex array is recorded.

The returned `GLMeshVao` exposes `indexCount` and owns its native vertex
array — not its buffers or its shader. Several vertex arrays may therefore share
one vertex and index buffer. `bindMeshVao(mesh)` uses the engine's
binding cache; `drawMesh(mesh, instanceCount, indexStart, indexCount)`
binds the mesh and draws triangles without allocating; `indexCount` defaults
to the indices from `indexStart` to the end. A range that is not whole indices
within the mesh throws a `RangeError` before anything is recorded. Without a
current program, drawing does nothing. Instancing is not
supported, so `instanceCount` must be `0`. `disposeMeshVao` releases the vertex
array independently of program references. Callers dispose vertex arrays before
the buffers they reference.

### 2.4 Textures and render targets

`NativeTextureHandle` is the host's opaque `Uint32Array<ArrayBuffer>` texture
handle. `wrapNativeTexture(engine, handle)` **borrows** native storage:
`disposeTexture` releases the wrapper but never deletes the storage.
`createRawTexture(engine, data, width, height, options?)`
**owns** RGBA8 storage and deletes it once every command recorded before its
disposal has been submitted, so a frame may still use a texture it disposes;
its `format` / `type`
options accept only `RGBA` / `UNSIGNED_BYTE` (the defaults) and it throws for
other formats. Raw storage can be sampled but not rendered into. The host
submits the commands recorded so far before each raw upload, so a raw texture
created inside a frame splits that frame's submission; create raw textures
before `beginFrame` when the number of submissions matters. Texture state
exposes `readonly width`, `readonly height`, and `isReady`; readiness becomes
false on disposal, as in Lite GL. Sampler state is set at wrapping or creation,
not per draw.

`createRenderTarget(engine, width, height, { colorTexture? })` either
allocates and owns an RGBA8 color texture or borrows the supplied
`colorTexture`; it always owns its framebuffer. A raw texture is rejected as
`colorTexture` before any host call; a wrapped host texture must have been
created renderable by the host. `disposeRenderTarget` releases
only the storage the target owns and accepts `null`. `bindRenderTarget(target)`
binds a target and `restoreDefaultFramebuffer(engine)` binds the native output;
both resolve the previous target first and set the viewport to cover the new
binding.

`updateWrappedNativeTexture(texture, handle)` replaces the storage of a
borrowed texture in place and rebuilds every framebuffer that renders into it.
The replacement must have the same dimensions; a shape change is rejected.
Every replacement framebuffer is created before any existing one is released,
so if the host fails, the texture and its targets keep their previous handles
and framebuffers. Lite GL cannot restore host storage that already changed
behind those handles; after a failure, retry the update or restore the host
storage before using the texture or its targets. Because a host can recreate
the storage behind the same handle object, a call with the current handle
rebuilds the framebuffers too; call it only when the host has replaced the
storage, not every frame.

### 2.5 State

The engine tracks the active framebuffer and viewport. As in Lite GL,
`setViewport(engine, viewport?)` takes a `GLViewport` in physical pixels of the
bound target and defaults to the size of the default output, whichever target is
bound; the native protocol's normalized viewport is derived from the bound
target's size. An explicit viewport of a bound target does not query the
default output size. `setScissor` uses physical pixels with the same bottom-left
origin as Lite GL; portable dimensions are nonnegative integers. A scissor rectangle without area clips everything, as in
WebGL: drawing and clearing do nothing until the scissor changes or
`disableScissor` is called. `setBlendMode` uses the Lite GL /
Babylon numeric presets. `clearEngine(engine, options)` takes `GLClearOptions`
and clears the requested buffers of the bound framebuffer.

### 2.6 Device reset

A native device reset invalidates the engine's cached bindings, not the caller's
ownership. Hosts dispose their renderer resources before a device change and
recreate them afterward, re-wrapping or replacing borrowed source and output
handles. The engine's reset callback reapplies the composition depth and culling
state and removes any scissor rectangle, including an empty one, before
rendering resumes.

## 3. Validation

Unit tests (`tests/gl/unit/native-lite-gl.test.ts`) drive the backend through a
protocol-recording runtime. They cover protocol mismatch, command scopes and
validation tags, stream capacity and rejected oversized commands, unchanged-state
elision, shared uniform values, sampler validation, disposed resources,
vertex-array reuse and attribute resolution, default index ranges, borrowed
versus owned texture disposal and deferred deletion, atomic target replacement,
rejected raw color attachments,
size limits, pixel viewports, empty scissors, clear options, `#version`
handling, unsupported raw formats, and rendering state after a native reset.
Package-output tests (`tests/gl/build/`) check the built `./native` export, that
its trimmed declarations type-check without the DOM library, that they still
keep web and native resources and resource kinds apart, that it imports without
a native runtime, and that the web and native entries tree-shake independently. The backend-family conformance test
(`tests/gl/unit/gl-family-conformance.test.ts`, `04-backend-family.md` §4)
checks every native export against `GLOps<NativeGLFamily>` or `NativeGLHostOps`.

This repository does not yet render the backend on a real Babylon Native host;
hosts validate rendering against a matching Babylon Native build.
