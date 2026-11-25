# Module: Lite GL backend family

> Source path: `packages/babylon-lite-gl/src/family.ts` (contract),
> `src/web-family.ts` and `src/native/family.ts` (backend mappings)
> Public entry: `@babylonjs/lite-gl/family` (type-only)

## 1. Purpose

Lite GL ships one function-based API with two backends: the WebGL2 barrel
(`@babylonjs/lite-gl`) and the Babylon Native entry
(`@babylonjs/lite-gl/native`, `03-native-lite-gl.md`). The family contract lets
backend-neutral consumer code call either backend without a bundler alias, a
runtime facade, or a namespace import:

- **`GLFamily`** names the resource and data types one backend works with.
- **`GLOps<F>`** describes every backend-neutral Lite GL operation over a
  family, using the backend's own types.
- **`GLKit<F, K>`** is the subset of operations a consumer selects. A browser
  or native composition root fills it with direct references to the concrete
  exported functions; shared code receives the kit.

The contract is types only. It adds no runtime code, so a consumer's bundle
retains exactly the functions its composition root references.

Backends differ honestly. A family maps each slot to the backend's real type,
so `GLOps<WebGLFamily>` keeps the full WebGL signatures while
`GLOps<NativeGLFamily>` keeps the native restrictions (for example non-null
sampler textures and non-instanced draws). Neither backend widens or narrows
its exported signatures to fit the other, and no operation validates arguments
at runtime on the contract's behalf.

## 2. Public API surface

### 2.1 Entries

| Entry                       | Exports                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@babylonjs/lite-gl/family` | `GLFamily`, `GLOps`, `GLOpName`, `GLKit`, `GLFamilyMarker`, `GLRenderTargetOf`, `GLFamilyPortableValues`, `GLFamilyTexture`, `GLFamilyRenderTarget`, `GLFamilyAttributeDescriptor`, `GLPortableAttributeDescriptor`, `GLFamilyMeshVertexBuffer`, `GLEffectOptions`, `GLViewport`, `GLClearOptions` |
| `@babylonjs/lite-gl`        | adds `WebGLFamily`, `WebGLHostOps`; re-exports `GLEffectOptions`, `GLViewport`, `GLClearOptions` from the family                                                                                                                                                                                   |
| `@babylonjs/lite-gl/native` | adds `NativeGLFamily`, `NativeGLHostOps`; re-exports `GLEffectOptions`, `GLViewport`, `GLClearOptions` from the family                                                                                                                                                                             |

`family.ts` imports nothing. Its declarations reference only ECMAScript types,
so `dist/family.d.ts` type-checks with `lib: es2022` and no DOM. `native/` imports
the family type-only, so neither the native runtime graph nor its declarations
reach a WebGL module or a DOM type.

### 2.2 Backend-neutral descriptors

`GLEffectOptions`, `GLViewport` and `GLClearOptions` are identical on both
backends, so the family owns them and both entries re-export them:

```ts
interface GLEffectOptions {
    name: string;
    vertexSource: string; // GLSL ES 3.00
    fragmentSource: string; // GLSL ES 3.00
    uniformNames: readonly string[];
    samplerNames: readonly string[]; // unit-assignment order
    attributeNames?: readonly string[]; // default ["position"]; the first is location 0
    defines?: string;
}
interface GLViewport {
    x: number;
    y: number;
    w: number;
    h: number;
}
interface GLClearOptions {
    color?: { r: number; g: number; b: number; a?: number };
    depth?: boolean;
    stencil?: boolean;
}
```

### 2.3 Capability shapes

Generic code can read these members of resource slots without knowing the
backend, and builds mesh inputs with `GLFamilyMeshVertexBuffer`:

```ts
interface GLFamilyTexture {
    readonly width: number;
    readonly height: number;
    readonly isReady: boolean;
}
interface GLFamilyRenderTarget<Texture> {
    readonly width: number;
    readonly height: number;
    readonly texture: Texture;
}
interface GLFamilyAttributeDescriptor {
    readonly name?: string;
    readonly size: number;
    readonly offset?: number;
    readonly divisor?: 0 | (number & {}); // lists 0 so per-vertex literals keep that type
}
interface GLFamilyMeshVertexBuffer<VertexBuffer, AttributeDescriptor> {
    buffer: VertexBuffer;
    attributes: readonly AttributeDescriptor[];
    computeStride?: boolean;
}
```

`GLFamilyMeshVertexBuffer` has exactly the fields and modifiers of both
backends' `GLMeshVertexBuffer`, so `createMeshVao` takes
`readonly GLFamilyMeshVertexBuffer<F["vertexBuffer"], F["attributeDescriptor"]>[]`
and still matches each export exactly.

### 2.4 `GLFamily` slots

Every slot is an accessor pair. The getter type, listed below, is the bound a
backend's type must satisfy and all that generic code may read from the slot.
The setter type is what generic code may write as the slot's value (§2.7). A
backend maps a slot to its real type with a `readonly` property, or to `never`
when it does not implement the feature.

| Slot                       | Bound                                   | `WebGLFamily`                | `NativeGLFamily`        |
| -------------------------- | --------------------------------------- | ---------------------------- | ----------------------- |
| `engine`                   | `object`                                | `GLEngineContext`            | `GLEngineContext`       |
| `effect`                   | `object`                                | `GLEffect`                   | `GLEffect`              |
| `effectWrapper`            | `object`                                | `GLEffectWrapper`            | `never`                 |
| `texture`                  | `GLFamilyTexture`                       | `GLTexture`                  | `GLTexture`             |
| `texture3D`                | `object`                                | `GLTexture3D`                | `never`                 |
| `renderTarget`             | `GLFamilyRenderTarget<GLFamilyTexture>` | `GLRenderTarget`             | `GLRenderTarget`        |
| `vertexBuffer`             | `object`                                | `GLVertexBuffer`             | `GLVertexBuffer`        |
| `indexBuffer`              | `object`                                | `GLIndexBuffer`              | `GLIndexBuffer`         |
| `meshVao`                  | `object`                                | `GLMeshVao`                  | `GLMeshVao`             |
| `spriteRenderer`           | `object`                                | `GLSpriteRenderer`           | `never`                 |
| `font`                     | `object`                                | `GLFont`                     | `never`                 |
| `glyphStorage`             | `object`                                | `GLGlyphStorage`             | `never`                 |
| `textData`                 | `object`                                | `GLTextData`                 | `never`                 |
| `defaultTextData`          | `object`                                | `GLDefaultTextData`          | `never`                 |
| `textLayer`                | `object`                                | `GLTextLayer`                | `never`                 |
| `textRenderer`             | `object`                                | `GLTextRenderer`             | `never`                 |
| `perfCounter`              | `object`                                | `GLPerfCounter`              | `never`                 |
| `noTexture`                | `null`                                  | `null`                       | `never`                 |
| `instanceCount`            | `number`                                | `number`                     | `0`                     |
| `vertexBufferArgs`         | `readonly unknown[]`                    | `[dynamic?: boolean]`        | `[]`                    |
| `floatArray`               | `ArrayLike<number>`                     | `Float32Array \| number[]`   | `ArrayLike<number>`     |
| `rawTextureData`           | `ArrayBufferView \| null`               | `ArrayBufferView \| null`    | `Uint8Array`            |
| `rawTextureOptions`        | `unknown`                               | `GLRawTextureOptions`        | `GLRawTextureOptions`   |
| `textureOptions`           | `unknown`                               | `GLTextureOptions`           | `GLTextureOptions`      |
| `renderTargetOptions`      | `unknown`                               | `GLRenderTargetOptions`      | `GLRenderTargetOptions` |
| `attributeDescriptor`      | `GLFamilyAttributeDescriptor`           | `GLAttributeDescriptor`      | `GLAttributeDescriptor` |
| `blendMode`                | `number`                                | `GLBlendMode`                | `GLBlendMode`           |
| `effectWaitOptions`        | `unknown`                               | `GLEffectWaitOptions`        | `never`                 |
| `effectWrapperOptions`     | `unknown`                               | `GLEffectWrapperOptions`     | `never`                 |
| `textureUpdateOptions`     | `unknown`                               | `GLTextureUpdateOptions`     | `never`                 |
| `floatTextureOptions`      | `unknown`                               | `GLFloatTextureOptions`      | `never`                 |
| `samplingMode`             | `number`                                | `GLSamplingMode`             | `never`                 |
| `samplingFilters`          | `unknown`                               | `GLSamplingFilters`          | `never`                 |
| `texture3DOptions`         | `unknown`                               | `GLPixelsTexture3DOptions`   | `never`                 |
| `floatRenderTargetOptions` | `unknown`                               | `GLFloatRenderTargetOptions` | `never`                 |
| `readPixelsOptions`        | `unknown`                               | `GLReadPixelsOptions`        | `never`                 |
| `blendState`               | `unknown`                               | `GLBlendState`               | `never`                 |
| `depthState`               | `unknown`                               | `GLDepthState`               | `never`                 |
| `stencilState`             | `unknown`                               | `GLStencilState`             | `never`                 |
| `stencilOpState`           | `unknown`                               | `GLStencilOpState`           | `never`                 |
| `spriteRendererOptions`    | `unknown`                               | `GLSpriteRendererOptions`    | `never`                 |
| `sprite`                   | `unknown`                               | `GLSprite`                   | `never`                 |
| `glyphCurves`              | `unknown`                               | `GLGlyphCurves`              | `never`                 |
| `quadCurve`                | `unknown`                               | `GLQuadCurve`                | `never`                 |
| `glyphRun`                 | `unknown`                               | `GLGlyphRun`                 | `never`                 |
| `textDataUpdate`           | `unknown`                               | `GLTextDataUpdate`           | `never`                 |
| `textLayoutOptions`        | `unknown`                               | `GLTextLayoutOptions`        | `never`                 |
| `textLayerOptions`         | `unknown`                               | `GLTextLayerOptions`         | `never`                 |
| `textRendererOptions`      | `unknown`                               | `GLTextRendererOptions`      | `never`                 |

The rows above `effectWaitOptions` cover the operations both backends
implement today plus the resource types of the web-only features; the rows
below are data types used only by web-implemented operations.

Slot values must describe the exported signatures exactly. The native
`vertexBufferArgs: []` reflects that native vertex buffers are immutable,
`instanceCount: 0` that native draws are non-instanced, `noTexture: never` that
native samplers cannot be unbound with `null`, and `rawTextureData: Uint8Array`
that native raw uploads take RGBA8 bytes.

### 2.5 `GLOps<F extends GLFamily>`

`GLOps` has one `readonly` function-typed property for each of the 137
backend-neutral operations of the web barrel (§3 of `00-lite-gl.md`). Each
member has the semantics of the identically named export and the exact web
signature with these substitutions, applied wherever the web type appears:

| Web type                                                                                          | Family type                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GLEngineContext`, `GLEffect`, `GLTexture`, … (every resource or data type of §2.4)               | `F["<slot>"]`                                                                               |
| `GLRenderTarget`                                                                                  | `GLRenderTargetOf<F>`                                                                       |
| `GLMeshVertexBuffer`                                                                              | `GLFamilyMeshVertexBuffer<F["vertexBuffer"], F["attributeDescriptor"]>`                     |
| `GLTexture \| null` / `GLTexture3D \| null` sampler arguments                                     | `F["texture"] \| F["noTexture"]` / `F["texture3D"] \| F["noTexture"]`                       |
| `Float32Array \| number[]` matrix and float-array arguments                                       | `F["floatArray"]`                                                                           |
| `createRawTexture` / `updateRawTexture` `data`                                                    | `F["rawTextureData"]`                                                                       |
| `updateRawTexture` options                                                                        | `F["textureUpdateOptions"] & { width?: number; height?: number; unpackAlignment?: number }` |
| `createVertexBuffer`'s trailing `dynamic?: boolean`                                               | `...args: F["vertexBufferArgs"]`                                                            |
| `instanceCount?: number` (`drawMesh`, `drawIndexed`)                                              | `instanceCount?: F["instanceCount"]`                                                        |
| `GLEffectOptions`, `GLViewport`, `GLClearOptions`, ECMAScript types and inline object/tuple types | unchanged                                                                                   |

`GLOpName` is `keyof GLOps<GLFamily>`.

The 137 members, grouped as in the web barrel:

- **Engine (23)** — `resizeGLEngine`, `setGLEngineSize`, `wipeGLStateCache`,
  `getRenderWidth`, `getRenderHeight`, `getTextureCount`,
  `getCurrentRenderTarget`, `getHardwareScalingLevel`,
  `setHardwareScalingLevel`, `onContextLost`, `offContextLost`,
  `onContextRestored`, `offContextRestored`, `getAlphaToCoverage`,
  `getCurrentSampleCount`, `setAlphaToCoverage`, `runRenderLoop`,
  `stopRenderLoop`, `beginFrame`, `endFrame`, `captureGPUFrameTime`,
  `getGPUFrameTimeCounter`, `setFramebufferValidation`.
- **Effects (29)** — `createEffect`, `useEffect`, `isEffectReady`,
  `getEffectCompilationError`, `executeWhenCompiled`, `disposeEffect`,
  `setEffectFloat`, `setEffectFloat2`, `setEffectFloat3`, `setEffectFloat4`,
  `setEffectColor3`, `setEffectColor4`, `setEffectVector2`,
  `setEffectDirectColor4`, `setEffectInt`, `setEffectTexture`,
  `setEffectMatrix`, `setEffectMatrix3x3`, `setEffectFloatArray`,
  `setEffectFloatArray2`, `setEffectFloatArray3`, `setEffectFloatArray4`,
  `setEffectIntArray`, `waitForEffect`, `createEffectWrapper`,
  `applyEffectWrapper`, `drawEffect`, `setViewport`, `disposeEffectWrapper`.
- **Textures (22)** — `createRawTexture`, `createFloatTexture`,
  `generateTextureMipMaps`, `loadTexture2D`, `bindTexture`, `unbindTexture`,
  `disposeTexture`, `updateRawTexture`, `updateTextureSamplingMode`,
  `updateTextureSamplingPreset`, `updateTextureWrapMode`,
  `getSamplingModeFilters`, `isTextureReady`, `createTexture3DFromPixels`,
  `bindTexture3D`, `unbindTexture3D`, `setEffectTexture3D`,
  `generateTexture3DMipMaps`, `updateTexture3DSamplingMode`,
  `updateTexture3DWrapMode`, `disposeTexture3D`, `createDynamicTexture`.
- **Render targets (9)** — `createRenderTarget`, `createFloatRenderTarget`,
  `bindRenderTarget`, `restoreDefaultFramebuffer`, `presentRenderTarget`,
  `generateRenderTargetMipMaps`, `resizeRenderTarget`,
  `readRenderTargetPixels`, `disposeRenderTarget`.
- **Meshes (15)** — `createVertexBuffer`, `updateVertexBuffer`,
  `createIndexBuffer`, `disposeBuffer`, `bindIndexBuffer`, `bindAttributes`, `bindAttributesCached`,
  `disableAttributeByIndex`, `unbindAllAttributes`, `unbindInstanceAttributes`, `drawIndexed`, `createMeshVao`, `bindMeshVao`,
  `drawMesh`, `disposeMeshVao`.
- **State (12)** — `setBlendMode`, `setBlendState`, `disableBlend`,
  `setDepthState`, `setCullState`, `setStencilState`, `setStencilOpSeparate`,
  `setColorMask`, `clearEngine`, `generateRenderTargetStencil`, `setScissor`,
  `disableScissor`.
- **Sprites (4)** — `createSpriteRenderer`, `renderSprites`,
  `setSpriteRendererTexture`, `disposeSpriteRenderer`.
- **Text (24)** — `loadFont`, `createFontFromBuffer`, `extractGlyphCurves`,
  `cubicToQuadratics`, `createGlyphStorage`, `updateGlyphStorage`,
  `disposeGlyphStorage`, `createTextData`, `updateTextData`, `disposeTextData`,
  `createDefaultTextData`, `updateDefaultTextData`, `disposeDefaultTextData`,
  `createTextLayer`, `setTextLayerPosition`, `createTextRenderer`,
  `renderText`, `isTextRendererReady`, `addTextRendererLayer`,
  `removeTextRendererLayer`, `registerTextRenderer`, `unregisterTextRenderer`,
  `disposeTextRenderer`, `setFontWeightOffset`.

Examples of the substitution rule:

```ts
readonly createVertexBuffer: (engine: F["engine"], data: Float32Array, ...args: F["vertexBufferArgs"]) => F["vertexBuffer"];
readonly setEffectTexture: (effect: F["effect"], samplerName: string, tex: F["texture"] | F["noTexture"]) => void;
readonly drawMesh: (vao: F["meshVao"], instanceCount?: F["instanceCount"], indexStart?: number, indexCount?: number) => void;
readonly createRenderTarget: (engine: F["engine"], width: number, height: number, options?: F["renderTargetOptions"]) => GLRenderTargetOf<F>;
```

### 2.6 Host operations

Operations that create or destroy an engine, or exchange data with
host-specific objects (DOM elements and image sources, WebGL handles, native
texture handles), have no backend-neutral meaning and stay outside `GLOps`.
Each backend lists them in a host-ops interface whose members are the
`typeof` of the exports:

| Interface         | Members                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebGLHostOps`    | `createGLEngine`, `createHostOwnedGLEngine`, `disposeGLEngine`, `getRenderingCanvas`, `createTextureFromHandle`, `createTextureFromSource`, `updateDynamicTexture`, `clearDynamicTextureSource`, `createHtmlElementTexture`, `updateHtmlElementTexture`, `readRenderTargetPixelsToBuffer` |
| `NativeGLHostOps` | `createNativeEngine`, `disposeNativeEngine`, `wrapNativeTexture`, `updateWrappedNativeTexture`                                                                                                                                                                 |

`clearDynamicTextureSource` and `updateHtmlElementTexture` take only a
`GLTexture`, but they manage a retained browser source (an image source or an
HTML element) and are meaningful only next to the host operation that supplied
it.

Every callable export of a backend entry is exactly one of: a `GLOps` member
implemented with the family signature, or a host-ops member. The web barrel
implements all 137 `GLOps` members; the native entry implements the 39 members
it exports. A backend that does not implement an operation does not export it.

### 2.7 Kits and the family marker

```ts
interface GLFamilyMarker<F extends GLFamily> {
    readonly glFamily?: F; // type-only; never set at runtime
}
type GLKit<F extends GLFamily, K extends GLOpName> = Pick<GLOps<F>, K> & GLFamilyMarker<F>;
```

The marker lets TypeScript infer `F` from a kit argument typed through another
alias, such as a consumer's `CompositorKit` below; the operation members alone
cannot, because they mention `F` only through indexed slots.

A consumer names the operations it uses, writes shared code generically over
the family, and fills one kit per backend in its composition root:

```ts
import type { GLFamily, GLKit } from "@babylonjs/lite-gl/family";

type CompositorOps = "createEffect" | "useEffect" | "setEffectTexture" | "createMeshVao" | "drawMesh";
export type CompositorKit<F extends GLFamily> = GLKit<F, CompositorOps>;

export function drawLayer<F extends GLFamily>(gl: CompositorKit<F>, effect: F["effect"], mesh: F["meshVao"], layer: F["texture"]): void {
    gl.useEffect(effect);
    gl.setEffectTexture(effect, "layer", layer);
    gl.drawMesh(mesh);
}

// Browser composition root.
import { createEffect, useEffect, setEffectTexture, createMeshVao, drawMesh, type WebGLFamily } from "@babylonjs/lite-gl";
const webKit: CompositorKit<WebGLFamily> = { createEffect, useEffect, setEffectTexture, createMeshVao, drawMesh };
```

The native root is identical with imports from `@babylonjs/lite-gl/native` and
`NativeGLFamily`. Passing a native kit with a web resource (or the reverse) is
a type error, and so is a value outside a concrete family's slot, such as a
`null` sampler texture passed through a native kit. Native resource types carry
a type-only identity of their backend and kind, so this holds against the
published declarations too, where internal members are removed and only a few
public fields would otherwise remain.

Concrete types are checked exactly where the family is known: in composition
roots and in the uber-kits of §4. Generic code is checked against what every
backend accepts, through the slot setter types:

| Slot                  | Generic code may write                        |
| --------------------- | --------------------------------------------- |
| `instanceCount`       | `0` (non-instanced draws)                     |
| `vertexBufferArgs`    | `[]` (a vertex buffer from its data alone)    |
| `floatArray`          | `Float32Array \| number[]`                    |
| `rawTextureData`      | `Uint8Array`                                  |
| `attributeDescriptor` | `GLPortableAttributeDescriptor`               |
| `blendMode`           | `0 \| 1 \| 2 \| 7` (the shared blend presets) |
| every other slot      | nothing (`never`)                             |

These values are `GLFamilyPortableValues`. Every other slot value, such as a
resource, `null` for a sampler, a blend state or an options object, reaches
generic code only from a backend operation or as a parameter supplied by a
composition root that knows the backend. Generic code therefore cannot unbind
a sampler with `null`, request an instanced draw, forge a resource from an
object literal or pass an unsupported blend preset, while the correlated flow still
type-checks without casts:

```ts
function drawThroughTarget<F extends GLFamily>(gl: GLKit<F, Ops>, engine: F["engine"], effect: F["effect"], indices: F["indexBuffer"]): GLRenderTargetOf<F> {
    const buffer = gl.createVertexBuffer(engine, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]));
    const mesh = gl.createMeshVao(engine, [{ buffer, attributes: [{ name: "position", size: 2, divisor: 0 }] }], indices, effect);
    const target = gl.createRenderTarget(engine, 4, 4);
    gl.setEffectTexture(effect, "source", target.texture); // F["texture"]
    gl.drawMesh(mesh, 0, 0, 6);
    return target;
}
```

Generic code names render targets `GLRenderTargetOf<F>` rather than
`F["renderTarget"]`. For a concrete family it is exactly that family's render
target type; for a generic family it keeps the attachment typed as
`F["texture"]`, which a plain indexed slot cannot express because TypeScript
reads it through the `GLFamily` bound.

## 3. Internal architecture

- `family.ts` declares §2.2–§2.7 and imports nothing.
- `web-family.ts` declares `WebGLFamily extends GLFamily` and `WebGLHostOps`
  with `import type` only; `index.ts` re-exports both with `export type`.
- `native/family.ts` declares `NativeGLFamily extends GLFamily` and
  `NativeGLHostOps` with `import type` only; `native/index.ts` re-exports both.
- `effect.ts`, `effect-renderer.ts`, `depth-stencil.ts` and their native
  counterparts import the §2.2 descriptors from `family.ts`.

The emitted `dist/family.js` is an empty module.

## 4. Completeness backstop

`tests/gl/unit/gl-family-conformance.test.ts` holds one test-only uber-kit per
backend entry: an object literal of direct references to every callable export,
typed `GLKit<WebGLFamily, GLOpName> & WebGLHostOps` (144 members) and
`GLKit<NativeGLFamily, NativeOpName> & NativeGLHostOps` (43 members), where
`NativeOpName` is derived as the native callable export names that are also
`GLOpName`s. Compile-time assertions, run by the mandatory
`tsc -p tests/gl/tsconfig.json` step of `pnpm run lint` and CI, require for each
entry:

1. Every callable export is either a `GLOpName` or a host-ops member, never
   both. A new export fails until it is classified.
2. The web barrel exports every `GLOpName` and every `WebGLHostOps` member; the
   native entry exports every `NativeGLHostOps` member.
3. Each `GLOps` member instantiated with the backend family is identical (not
   merely assignable) to the exported function's type. A signature change on
   either side fails until the family or its mapping is updated.
4. Each uber-kit lists every callable export. A runtime assertion also compares
   each uber-kit's keys and references with the entry's function exports.

Because `extends` does not compare setter types, the test also requires each
backend's mapping to accept every `GLFamilyPortableValues` member, among the
slots that backend implements.

Callable exports are found by type, so `GLBlendMode`, `GLBlendEquation` and
`GLSamplingMode` (preset objects) are not operations. No export is exempted by
name.

`tests/gl/unit/gl-family-consumer.test.ts` proves the consumer pattern of §2.7:
a generic function creates, binds and draws through a kit with no casts, runs
against the mocked WebGL backend, infers the family from web and native kits
passed through the consumer's own kit alias (which needs the family marker),
and rejects a native kit with a web engine or an unsupported blend preset. Its
generic negative fixture requires compile errors for `null` sampler textures,
instance counts other than `0`, extra vertex-buffer arguments, attributes
without a name and per-vertex divisor, render-target literals and unsupported
blend presets, and its positive fixture applies every shared blend preset.

`tests/gl/build/public-api.test.ts` checks that the emitted manifest exports
`./family`, and that `dist/family.d.ts` and `dist/native/index.d.ts` type-check
without the DOM library.

## 5. Dependencies

None. The family entry has no runtime code and no imports.

## 6. File manifest

```
packages/babylon-lite-gl/
    AGENTS.md                coordinated-update rule for exports, family and uber-kits
    src/family.ts            GLFamily, GLOps, GLKit, capability shapes, shared descriptors
    src/web-family.ts        WebGLFamily, WebGLHostOps
    src/native/family.ts     NativeGLFamily, NativeGLHostOps
tests/gl/unit/
    gl-family-conformance.test.ts   uber-kits and exhaustive conformance assertions
    gl-family-consumer.test.ts      generic consumer, inference and cross-backend rejection
```
