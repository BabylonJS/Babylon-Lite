# Module: Texture2DArray

> Package path: `packages/babylon-lite/src/texture/texture-array.ts`

## Purpose

Provides tree-shakeable WebGPU 2D texture-array creation and upload helpers for image sources, raw pixels,
one multi-layer KTX2 container, or an ordered list of separate single-layer KTX2 files.

## Ownership

`texture-array.ts` owns array shape validation and GPU upload. `ktx2-loader.ts` remains the only owner of
decoder loading, device capability selection, transcoded format resolution, and KTX2 orientation.

## Separate-file KTX2 contract

`uploadKtx2Texture2DArrayFromBuffers(engine, buffers, sRGB)` decodes every buffer with the shared KTX2
decoder and places source `buffers[i]` in array layer `i`. Each source must describe one 2D layer. All
sources must produce the same transcoded format, base dimensions, mip count, and dimensions at each mip
level. A mismatch rejects before any GPU texture is created.

`loadKtx2Texture2DArrayFromUrls(engine, urls, sRGB)` only owns fetching and delegates the decoded buffers
to the same upload contract.

The authored mip chains remain compressed when the device supports their transcode target. Upload is
unflipped and the returned texture carries `invertY = true`, matching the existing KTX2 paths.

## Shader contract

Declare the sampler with `viewDimension: "2d-array"` and bind the returned `Texture2DArray` through
`setShaderTexture`. WGSL samples a layer with an explicit integer index:

```wgsl
textureSampleGrad(surfaceMap, surfaceMapSampler, uv, layer, dx, dy)
```

## Failure behavior

An empty source list, a multi-layer source, incompatible source metadata, fetch failure, decoder failure,
or unsupported transcoded format rejects explicitly. Every buffer is normalized before any asynchronous
decode starts. Decoded dimensions, device-format support, compressed block alignment, and every compressed
or uncompressed mip payload size are preflighted before GPU allocation. The logical dimensions come from the
base mip because a decoder may report padded container dimensions for compressed output. Device 2D-dimension
and array-layer limits plus the legal mip-count bound are checked before `createTexture`. A later view, sampler,
or upload failure destroys the partially created texture before the error is rethrown. Validation and
out-of-memory error scopes are awaited before ownership is acquired, so asynchronously reported WebGPU
failures also reject and destroy the invalid texture.
