# Module: Texture render targets

> Package path: `packages/babylon-lite/src/texture/texture-render-target.ts`

## Purpose

Borrow one array layer and mip of an existing render-attachment texture as a `RenderTarget`.
No new texture is allocated. Color, depth-only, stencil-only, and combined depth/stencil formats
use the corresponding attachment slots instead of treating every texture as a color attachment.

## Public API Surface

```typescript
export interface TextureRenderTargetOptions {
    readonly layer?: number;
    readonly mipLevel?: number;
}

export function createTextureRenderTarget(
    engine: EngineContext,
    texture: Texture2D,
    options?: TextureRenderTargetOptions
): RenderTarget;

export function disposeRenderTarget(target: RenderTarget | null | undefined): void;
```

Both subresource indices default to zero. The function accepts `Texture2DArray` through its
`Texture2D` base interface. Dispose the returned target with `disposeRenderTarget(target)`;
the supplied texture remains caller-owned. Both operations are available from the public package root.

## Internal Architecture

Validate render-attachment usage, the `"2d"` texture dimension, and integer layer/mip indices
within the allocation's layer and mip counts before acquiring ownership.

The descriptor copies the allocation label and sample count. Its dimensions are
`max(1, gpu.width >> mipLevel)` and `max(1, gpu.height >> mipLevel)`. Formats beginning with
`"depth"`, and `"stencil8"`, populate `dFormat`; other formats populate `format`.

Create one view with dimension `"2d"`, `baseArrayLayer = layer`, `arrayLayerCount = 1`,
`baseMipLevel = mipLevel`, and `mipLevelCount = 1`. Color targets populate `_colorTexture`
and `_colorView`; depth/stencil targets populate `_depthTexture` and `_depthView`.
The unused attachment pair remains null.

Color wrappers also retain `_colorSubresource = { layer, mipLevel }` on the target.
These validated scalar indices describe the attachment view independently of the whole
`_colorTexture` allocation. `CopyToTextureTask` uses them for its raw-copy destination:
`mipLevel` selects the destination mip and `origin = { x: 0, y: 0, z: layer }` selects
the destination layer. The copy extent is the selected mip's dimensions, not the
allocation's base dimensions. Ordinary targets without this metadata keep the default
layer-zero, mip-zero destination. Blit and resolve destinations already use the selected
attachment view and do not need a different path.

Mark the target eager. Its `_syncEager` hook rejects disposal, compares the live attachment
allocation with `texture.texture`, and recreates only the view when the facade's compatible
allocation was replaced. Ordinary `buildRenderTarget` calls therefore never allocate another
attachment or overwrite the selected layer/mip. Color subresource metadata is refreshed with
the same captured indices alongside the replacement view.

## Pipeline Configuration

The target's color or depth/stencil format and sample count determine the render pipeline
signature. Depth targets retain the render-target owner's reverse-Z defaults. A stencil-only
target has no depth aspect; render passes and render pipelines must omit depth-only state.

## Shader Logic

No shader is owned by this module. Render-draw, effect, or clear tasks supply their own behavior.
This wrapper does not generate mipmaps or change texture UV orientation.

## State Machine / Lifecycle

1. Validate the subresource and create its attachment view.
2. Acquire exactly one logical texture reference.
3. Borrow the same target repeatedly; a compatible facade replacement refreshes its view.
4. On the first disposal, mark the wrapper disposed and release exactly its acquired reference.
5. Further disposal calls do nothing; a subsequent build throws.

The wrapper never destroys a texture directly. Shared texture reference counting determines
when the last owner releases the allocation. The texture, its other views, and other wrappers
remain owned independently.

## Babylon.js Equivalence Map

Equivalent to selecting an existing render-target attachment's array layer or mip without
creating a second texture. Lite exposes a plain target and standalone lifecycle functions
instead of an attached render-target method.

## Dependencies

`engine/render-target.ts` owns target lifecycle, `engine/gpu-flags.ts` supplies usage flags,
and `resource/texture-acquire.ts` / `texture-release.ts` own logical allocation references.
`texture-2d.ts` is imported only for its facade type. No module-level cache or registration exists.

## Test Specification

`tests/lite/unit/texture-render-target.test.ts` covers exact layer/mip view descriptors, dimensions,
sample count, each attachment classification, eager-build identity, facade replacement, invalid
usage/dimension/indices, and idempotent disposal. Disposing a wrapper twice must not destroy its
still-owned source; releasing the remaining source owner must destroy the allocation exactly once.

`tests/lite/unit/copy-to-texture-task.test.ts` integrates the array factory, wrapper, and copy
task. A 128x64 `rgba16float` source copied into layer 5, mip 1 of a 256x128 array must issue an
encoder copy to exactly that layer/mip with extent 128x64 and no draw or pipeline creation.
Layer-only, mip-only, default selection, and a nonzero source LOD retain the same fast-path
contract. Re-recording preserves the destination, and disposing the borrowing task leaves
the wrapper and the array's references intact.

`tests/lite/unit/render-shader.test.ts` covers depth/stencil pass operations and stencil-only
pipeline state when these targets are used by render-draw tasks.
`tests/lite/build/public-api-types.test.ts` checks that emitted root declarations expose wrapper
creation and disposal together.

## File Manifest

- `texture/texture-render-target.ts`: subresource validation, view attachment, ownership hooks.
- `engine/render-target.ts`: existing target owner and disposal entry point.
- `frame-graph/copy-to-texture-task.ts`: raw-copy destination subresource selection.
- `tests/lite/unit/texture-render-target.test.ts`: wrapper regression coverage.
- `tests/lite/unit/copy-to-texture-task.test.ts`: copy destination integration coverage.
