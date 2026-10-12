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
`_colorTexture` allocation. `CopyToTextureTask` uses them for either raw-copy endpoint:
`mipLevel` selects its mip and `origin = { x: 0, y: 0, z: layer }` selects its layer.
The copy extent is the selected mip's dimensions, not the allocation's base dimensions.
`lodLevel` is relative to the source sampling view. A wrapper exposes only one mip,
so sampling clamps to view-relative LOD zero, regardless of `lodLevel`; the raw-copy
path likewise uses the wrapper's selected physical mip and its unshifted `_width`/`_height`.
It never adds `lodLevel` to that physical mip or applies it a second time to the dimensions.
Ordinary sources without this metadata retain their existing `lodLevel` mip selection;
ordinary destinations keep layer zero and mip zero. Blit and resolve paths already
use the selected attachment view and do not need a different path.

Mark the target eager. Its `_syncEager` hook rejects disposal, compares the live attachment
allocation with `texture.texture`, and recreates only the view when the facade's compatible
allocation was replaced. Ordinary `buildRenderTarget` calls therefore never allocate another
attachment or overwrite the selected layer/mip. Color subresource metadata is refreshed with
the same captured indices alongside the replacement view.
The replacement also republishes `_width`, `_height`, and descriptor `size`
from the new allocation at the selected mip, using the same one-pixel minimum.
This applies to color and depth/stencil wrappers. A real surface-sized RTT may
replace its facade allocation before the borrowing wrapper is synchronized;
the wrapper then exposes the live dimensions to attachment compatibility checks.
`ClearTextureTask` invokes the eager synchronization hook again during pass
initialization, after every task has finished recording and before validating
or caching attachments. Its record phase may have prepared the borrowing wrapper
before preparing the source RTT. Initialization refreshes that earlier wrapper
without allocating another ordinary render target.
`RenderDrawTask` likewise registers a phase-2 initializer while retaining direct execution.
The initializer synchronizes the task's current eager target, including a target changed
by the setter during recording, then refreshes its cached attachments. Ordinary targets
retain their record-time allocation and cache. This does not refresh views already captured
in another task's bind group or copy command; those consumers must prepare their own
resources after the source allocation is current.

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
Replacement cases cover changed dimensions at mip zero and a nonzero selected
mip, including depth/stencil attachments. A real
`createSurfaceRenderTargetTexture` resize regression in
`tests/lite/unit/frame-graph-texture-tasks.test.ts` rebuilds a clear task using
the color wrapper with the original RTT's depth attachment using only
`graph.build()`, without manually building the source RTT after resize.
Both live dimensions and attachment views must be refreshed without a
compatibility error, and the source's color and depth allocations must each be
replaced only once. Additional color and depth wrapper cases place the source's
allocation task later in record order and verify that pass initialization and
actual render-pass attachments use the replacement allocation. Ordinary borrowed
targets must retain their allocations during initialization and unchanged-size
rebuilds.
Render-draw attachment regressions use the same real surface RTT with color and sampled-depth
wrappers in both producer orders. Resize followed by synchronous `graph.build()` alone must
refresh the wrapper and actual render-pass view, allocate each source attachment once,
preserve format/sample signatures and cached pipelines, and remain correct after retirement
and an unchanged rebuild. Enabled draws exercise pipeline lookup and draw encoding with GPU
mocks, without claiming native pixel validation. Disabled execution must not suppress
initialization, and disposing the draw task must leave its borrowed target alive. Ordinary
targets must not allocate again in phase 2.

`tests/lite/unit/copy-to-texture-task.test.ts` integrates the array factory, wrapper, and copy
task. A 128x64 `rgba16float` source copied into layer 5, mip 1 of a 256x128 array must issue an
encoder copy to exactly that layer/mip with extent 128x64 and no draw or pipeline creation.
Layer-only, mip-only, default selection, and a nonzero source LOD retain the same fast-path
contract. Re-recording preserves the destination, and disposing the borrowing task leaves
the wrapper and the array's references intact.
Source-wrapper cases cover layer-only, mip-only, combined, and default selection.
The native-copy fixture models a `COPY_SRC`-capable allocation; the ordinary array
factory does not request this usage and retains the view-based blit fallback.
Layer 5, mip 1 of that 256x128 array copied into a matching 128x64 target must select
physical source mip 1 and `origin.z = 5`, including nonzero and out-of-chain
`lodLevel` values that clamp to the wrapper's only exposed mip. Re-recording preserves
the source view and ownership. A differently sized destination uses the blit path
and binds that same selected source view rather than sampling the whole array.

`tests/lite/unit/render-shader.test.ts` covers depth/stencil pass operations and stencil-only
pipeline state when these targets are used by render-draw tasks.
`tests/lite/build/public-api-types.test.ts` checks that emitted root declarations expose wrapper
creation and disposal together.

## File Manifest

- `texture/texture-render-target.ts`: subresource validation, view attachment, ownership hooks.
- `engine/render-target.ts`: existing target owner and disposal entry point.
- `frame-graph/copy-to-texture-task.ts`: raw-copy endpoint subresources and view-relative source LOD.
- `tests/lite/unit/texture-render-target.test.ts`: wrapper regression coverage.
- `tests/lite/unit/copy-to-texture-task.test.ts`: copy source/destination integration coverage.
