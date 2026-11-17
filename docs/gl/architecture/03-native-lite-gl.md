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
    "./native": { "import": "./native/index.js", "types": "./native/index.d.ts" }
}
```

The two entries are independent module graphs. The web barrel never imports
`native/`, and `native/` never imports the WebGL modules, so each consumer's
bundle contains only the backend it imports. Neither entry has import-time
side effects: the native runtime (`globalThis._native`) is read only when an
engine is created. Relative imports keep explicit `.js` extensions, so the
emitted files are runnable ESM without a bundler.

A host selects a backend at build time (for example with a bundler alias) and
calls the matching standalone functions. Platform selection is a build concern;
there are no `ThinEngine`, `ThinTexture`, or `Effect` lookalikes.

For the composition subset it implements, the native entry follows the web
entry's API: the same `GL*` type names (`GLEngineContext`, `GLEffect`,
`GLTexture`, `GLRenderTarget`, `GLMeshVao`, …), function signatures, and option
objects, including the receiver rule: operations on an existing resource take
the resource first and derive its engine from it. Code written against that subset of `@babylonjs/lite-gl` compiles
against `@babylonjs/lite-gl/native` without an adapter. Engine creation,
frame bracketing, and borrowed host textures are native-specific additions.

## 2. Contract

Public handles are pure state; standalone functions own engine creation,
effects, buffers, sampled textures, render targets, and drawing. The caller
supplies GLSL ES 3.00 shaders and explicit attribute, uniform, and sampler names,
as with Lite GL. Shader includes and any host-specific shader preparation belong
to the caller, not to the native command encoder. A leading `#version` line is
dropped because the native compiler takes unversioned GLSL; any `defines` lead
the source sent to the native compiler.

### 2.1 Engine and frames

`createNativeEngine()` requires Babylon Native engine protocol 9 and creates
one native engine and one reusable 64 KiB command stream. It sets hardware
scaling to one and disables depth test, depth writes, and culling for
composition. As in Lite GL, `getRenderWidth` / `getRenderHeight` report the
native output size, `getCurrentRenderTarget` reports the bound target, and
`engine.caps.maxTextureSize` reports the device texture limit.

`beginFrame(engine)` and `endFrame(engine)` bracket command submission;
`endFrame` submits everything recorded, including a partially encoded frame
being unwound after a caller error. Resource operations outside a frame submit
immediately. Nested or unmatched frame scopes are errors.

`disposeNativeEngine(engine)` is idempotent and disposes the native engine.

### 2.2 Effects

`createEffect(engine, options)` compiles the supplied source and resolves all
declared names once and throws on failure, so `isEffectReady` is true until
disposal and `getEffectCompilationError` always returns `null`. Each effect owns
its program and a value cache. Uniform
setters bind that program before uploading, ignore absent uniforms, and skip
unchanged values. Every setter for a given uniform name shares one numeric value
cache, so scalar, integer, vector, and array setters elide against each other;
array setters compare values rather than array identity. Uniform data belongs to each native program.

Texture slots belong to the frame encoder instead: sampler bindings are reused
only within the same frame and program run, and are rebound after a program
switch or a new frame. `useEffect` and indexed drawing share the engine's
program and vertex-array caches. `disposeEffect` releases only the program.

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
locations come from the supplied effect.

The returned `GLMeshVao` exposes `indexCount` and owns its native vertex
array — not its buffers or its shader. Several vertex arrays may therefore share
one vertex and index buffer. `bindMeshVao(mesh)` uses the engine's
binding cache; `drawMesh(mesh, instanceCount, indexStart, indexCount)`
binds the mesh and draws triangles without allocating. Instancing is not
supported, so `instanceCount` must be `0`. `disposeMeshVao` releases the vertex
array independently of program references. Callers dispose vertex arrays before
the buffers they reference.

### 2.4 Textures and render targets

`NativeTextureHandle` is the host's opaque `Uint32Array<ArrayBuffer>` texture
handle. `wrapNativeTexture(engine, handle)` **borrows** native storage:
`disposeTexture` releases the wrapper but never deletes the storage.
`createRawTexture(engine, data, width, height, options?)`
**owns** RGBA8 storage and deletes it on disposal; its `format` / `type`
options accept only `RGBA` / `UNSIGNED_BYTE` (the defaults) and it throws for
other formats. Texture state
exposes `readonly width`, `readonly height`, and `isReady`; readiness becomes
false on disposal, as in Lite GL. Sampler state is set at wrapping or creation,
not per draw.

`createRenderTarget(engine, width, height, { colorTexture? })` either
allocates and owns an RGBA8 color texture or borrows the supplied
`colorTexture`; it always owns its framebuffer. `disposeRenderTarget` releases
only the storage the target owns and accepts `null`. `bindRenderTarget(target)`
binds a target and `restoreDefaultFramebuffer(engine)` binds the native output;
both resolve the previous target first and set the viewport to cover the new
binding.

`updateWrappedNativeTexture(texture, handle)` replaces the storage of a
borrowed texture in place and rebuilds every framebuffer that renders into it.
The replacement must have the same dimensions; a shape change is rejected.

### 2.5 State

The engine tracks the active framebuffer and viewport. As in Lite GL,
`setViewport(engine, viewport?)` takes a `GLViewport` in physical pixels and
defaults to the full output; the native protocol's normalized viewport is
derived from the bound target's size. `setScissor` uses physical pixels with
the same bottom-left origin as Lite GL. `setBlendMode` uses the Lite GL /
Babylon numeric presets. `clearEngine(engine, options)` takes `GLClearOptions`
and clears the requested buffers of the bound framebuffer.

### 2.6 Device reset

A native device reset invalidates the engine's cached bindings, not the caller's
ownership. Hosts dispose their renderer resources before a device change and
recreate them afterward, re-wrapping or replacing borrowed source and output
handles. The engine's reset callback reapplies the composition depth and culling
state before rendering resumes.

## 3. Validation

Unit tests (`tests/gl/unit/native-lite-gl.test.ts`) drive the backend through a
protocol-recording runtime. They cover protocol mismatch, command scopes and
validation tags, unchanged-state elision, shared uniform values, vertex-array
reuse, borrowed versus owned texture disposal, target replacement, pixel
viewports, clear options, `#version` handling, unsupported raw formats, and
rendering state after a native reset. Package-output tests (`tests/gl/build/`) check the
built `./native` export, its trimmed declarations, import without a native
runtime, and that the web and native entries tree-shake independently.

This repository does not yet render the backend on a real Babylon Native host;
hosts validate rendering against a matching Babylon Native build.
