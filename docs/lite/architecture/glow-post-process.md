# Module: Glow post-process

> Package paths: `packages/babylon-lite/src/post-process/glow.ts`, `packages/babylon-lite/src/material/glow/`

## Purpose

An opt-in `GlowPostProcessTask` renders selected emissive contributions, blurs them at two resolutions, and blends them into an explicitly supplied color destination. It is not bloom: opaque non-emitting objects still write black and depth, so they occlude emitters. It introduces no EffectLayer/ThinXXX hierarchy, rendering groups, scene-output discovery, or per-frame graph rearrangement.

The caller places the complete task after the desired color producer and before subsequent rendering/post-processing. Multiple render tasks express layering. There is no `renderingGroupId`.

## Public API Surface

`createGlowPostProcessTask(config, engine, scene)` returns a `GlowPostProcessTask` implementing the existing frame-graph `Task` lifecycle.

- Required `targetTexture: RenderTarget`: borrowed color destination, loaded rather than cleared.
- Optional `resolveTexture: RenderTarget`: borrowed single-sample resolve destination for an MSAA target.
- Optional `meshes: readonly Mesh[]` and `camera: Camera`: default to the owning scene's live meshes and camera.
- `mainTextureRatio = 0.5`, or a positive `mainTextureFixedSize` for square, resize-independent intermediates.
- `mainTextureType = 0`: unsigned-byte RGBA; `2` selects half-float RGBA. `mainTextureFormat = 5` denotes RGBA. Unsupported values throw instead of being silently ignored.
- `blurKernelSize = 32`: each of the four Gaussian passes uses half this value.
- Live `intensity = 1`, `isEnabled = true`, `neutralColor = { r: 0, g: 0, b: 0, a: 1 }`, and `excludeByDefault = false`.
- `alphaBlendingMode = 1`: Babylon additive blending, preserving destination alpha. Supported additional modes have explicit equivalent GPU states.
- `ldrMerge = false`: when enabled, clamp the summed, intensity-scaled RGBA before blending.
- Optional `customEmissiveColorSelector(mesh, material, result)` writes reusable `{ r, g, b, a }` state.
- Optional `customEmissiveTextureSelector(mesh, material)` overrides the source emissive texture; returning `null` explicitly removes it.
- Mutable `includedOnlyMeshes` and `excludedMeshes` sets provide explicit selection without custom attached methods.

The task explicitly publishes `outputTexture` (the supplied color target), `resolveTexture`, its owned `emissiveTexture`, and both `blurredTextures`. Internally allocated scratch textures are never inferred from other tasks. Borrowed outputs are neither rebuilt nor disposed by this feature.

## Internal Architecture

The task owns one emissive color/depth target and four blur targets. Default emissive storage is `rgba8unorm`; blur storage is `rgba16float`. The depth target is `depth32float`, single-sample, reverse-Z.

The material-owned glow renderer reads source state without mutating source materials, for the four material families. Standard and PBR provide their emissive color/textures. As in Babylon.js, a material without an emissive color (NodeMaterial without a glow output, ShaderMaterial) renders the task's `neutralColor` with its own alpha mode, blending, culling and, for ShaderMaterial, topology, so it still occludes. Selectors still apply to these generic surfaces. Other material families fail explicitly. Shader variants are shared across meshes and keyed only by what changes the glow shader or pipeline: deformation families, PBR primitive bits (mirrored winding and topology), surface flags (alpha test/blend and blend mode, double-sided, opacity-from-RGB, vertex alpha, per-slot texture presence, per-slot second UV set, linear emissive source, topology) and the vertex-buffer layout key. Mesh/world/emissive/UV data and source-resource bindings belong to each draw.

A NodeMaterial whose FragmentOutput `glow` input (Babylon's `additionalColor`) is connected renders through its own shader instead, as Babylon.js does with `USEADDITIONALCOLOR`. The node emitter resolves that input with the material, so its uniforms, textures and named inputs belong to the material's normal layout; the build state keeps the cast `glow`/`a` expressions. The lazily imported `material/glow/glow-node.ts` compiles the same build state with only the final output assignment replaced by `vec4(glow, a or 1)` for the glow-map format and depth, so the vertex graph, deformation, environment and shadow bindings, alpha mode and culling all apply. Each task holds one program per source material with its own copy of the node UBO, synchronized from the material's uniform values at most once per frame and uploaded only when a value changed; each draw has its own mesh UBO, repacked under the forward pass's world/shadow/light-count contract. Like the forward node renderable, a draw rebuilds its bind group (textures, vertex deformation, environment, shadows) and selects its mesh pipeline only when its source surface refreshes, never per frame. Selectors are not called for these meshes.

Each generic draw's 192-byte uniform buffer contains world matrix floats 0-15, selected RGBA 16-19, three pairs of affine-UV rows at 20-43, and opacity level at 44 (45-47 are padding). Group 0 uses the existing scene/light layout. The task packs the full scene uniforms (base pack plus scene contributors) under the forward pass's change key: camera, `_cameraChangeKey`, projection aspect, fog, exposure, contrast and environment. The key is published as the task's `_sceneUboCacheKey`, so scene-uniform writers outside it (environment rotation and blur, clip plane, procedural sky) invalidate it with the forward caches. Generic glow shaders read only its view-projection; NodeMaterial programs read the same uniforms as their forward pass. Under floating origin the uploaded view is origin-relative, matching the camera-relative mesh worlds. The scene group binds the scene's shared lights, which follow the scene camera; under floating origin with a task camera override, and only while NodeMaterial programs exist, it binds a task-owned lights buffer refreshed each frame relative to that camera, without touching the shared one. Group 1 binds the draw buffer at 0, optional morph delta/weight storage, an optional bone texture, then each present alpha/opacity/emissive texture and sampler in that order. Shared deformation fragments determine the corresponding extra vertex attributes. Draw pipelines write reverse-Z depth for opaque/alpha-test surfaces; transparent surfaces blend with their Babylon alpha mode (by default RGB source-over and additive alpha, matching the reference glow-map pass) and do not write depth. PBR pipelines take topology and strip format from the mesh's glTF primitive state; every pipeline derives its winding from the mirrored bit, reversed in right-handed builds.

Per-frame work follows the engine's existing change contracts rather than re-deriving everything:

- A draw re-reads its source surface (`readGlowSurface`, variant, texture rows, bindings) only when its material identity, the source `_uboVersion` (`markMaterialUboDirty`) or the task epoch changes. The epoch moves when the task records and when `scene._renderableVersion` moves (material rebuilds, mesh/material swaps, removals, recovery).
- The world matrix is repacked only when `worldMatrixVersion` changes, or, under floating origin, when the camera or its world version changes.
- Uniforms are written with one `writeBuffer` only when a stored float32 value actually changed.
- Custom selectors run every frame for every candidate mesh. The color selector receives a per-draw copy initialized with the source color, so the source state survives unchanged frames. A changed texture selection refreshes that draw, and replacing or removing the texture selector moves the epoch so no surface keeps a previous override.
- A draw whose thin-instance input disappears (instances removed, or a NodeMaterial program without instance inputs) drops its indirect arguments and instance buffer and draws one instance.

Draws stay allocated while their mesh remains in the population, including while hidden or excluded, so visibility toggles do not churn buffers, bind groups or leases. A draw is released when its mesh leaves the population or the scene removes it.

The emissive draws are recorded once into a render bundle (scene group, pipelines, vertex/index buffers, draw groups) and replayed each frame. The bundle is re-recorded only when the ordered draw list changes, a draw's commands change (variant, bindings, thin-instance buffer or indirect arguments), or the epoch moves.

The shader computes world position before applying view-projection, avoiding a matrix-matrix multiply per vertex. Affine UV rows are applied per fragment: the map is half resolution and one raw UV varying serves every texture of a channel. Structural resource changes snapshot the actual texture/sampler resources and fence the retired leases, so a replaceable texture facade cannot release its new backing instead of the old one.

Vertex deformation reuses the existing material-agnostic skeleton, morph and instance shader fragments and GPU buffers. Optional deformation helpers are preloaded with the task, as is the node glow module when the population has a NodeMaterial with a glow output. A mesh whose deformation family or node glow program appears later is skipped, like an unready reference submesh, while its helpers are imported or its program compiles. Vertex-animation textures and generic skeletal plus thin-instance deformation fail explicitly, unless the caller excludes those meshes.

## Pipeline Configuration

1. Clear and render the emissive map in one pass, with private cleared reverse-Z depth, by replaying the cached emissive bundle.
2. Horizontal and vertical Gaussian blur at emissive-map resolution.
3. Horizontal and vertical Gaussian blur at half that resolution. The second horizontal pass directly samples the first vertical result, combining downsampling and blur.
4. Blend the two blurred levels into the borrowed final target, optionally resolving it.

There are six render passes, not seven: the clear is a load operation in the geometry pass. Composition samples only the two blur textures, never the destination. Its pipeline sample count matches the destination, independently of the single-sample emissive map. The merge pipeline is created once per device; resizes only rebind the blurred sources. Blur uniforms are written when recorded and when the kernel changes, not every frame.

The emissive map is projected with the destination aspect (times the camera viewport aspect), never the map's own aspect: the map is sampled in destination screen space, so a square `mainTextureFixedSize` map must not change the projection.

When no mesh is drawn, the neutral color is black and the blend mode is `1` or `6`, the merge cannot change the destination. After one such frame has cleared the map and both blur levels to the neutral color, later such frames submit no passes; any draw, record, neutral-alpha change or other mode runs the full chain again, so published intermediates stay coherent.

Default merge blending is RGB `{src-alpha, one}` and alpha `{zero, one}`. Ordinary native post-process additive alpha accumulation is not equivalent and must not be used.

## Shader Logic

Default emissive RGB is the Standard emissive color, or the effective PBR emissive factor (white for an emissive texture without an explicit factor, otherwise black without either input). Native glTF emissive strength is already included; do not multiply it twice. NodeMaterial (without glow output) and ShaderMaterial surfaces use `neutralColor` and have no textures.

Selected color alpha is multiplied by applicable diffuse/albedo alpha, opacity, and explicit vertex alpha. Diffuse/albedo alpha is sampled only when it applies in the reference pass: for an alpha test, which requires that texture, and for PBR blending through the albedo alpha. Standard has no alpha-from-diffuse mode, so a translucent Standard surface does not sample its diffuse texture, and an alpha cutoff without a diffuse/albedo texture performs no test. Alpha testing uses the glow cutoff `0.4`, before emissive texture multiplication. The emissive sample then multiplies the selected RGBA. Linear emissive samples are converted back to gamma space for glow generation, as the reference does for a texture with `gammaSpace = false`: every PBR sample (PBR shades emissive samples as linear values), and hardware-decoded sRGB or float samples of other materials.

Opaque occluders write black color as well as depth. Selected output alpha does not reclassify an opaque material as transparent. Transparent source surfaces blend after opaque/alpha-test surfaces and do not write depth. Excluded meshes are absent and therefore do not occlude.

Each texture uses its own UV channel, affine transform and native `invertY` convention. No extra render-target Y flip is introduced.

## State Machine / Lifecycle

Creation stores state and allocates CPU-side handles. Preload imports only deformation families present in the mesh population, and the node glow module with its programs when a NodeMaterial glow output is present. Recording allocates/rebinds owned targets, draw resources, blur passes and the borrowed-destination merge.

Execution reconciles the mesh population and resource generations without scanning graph topology. It updates changed draw state, replays or re-records the emissive bundle, executes four blurs, and merges. Disabled tasks submit no passes and retain their allocations for reactivation. As in the reference layer, `excludeByDefault` with an empty inclusion set also submits no passes and calls no selectors.

Resize rebuilds owned targets and dependent bindings, never the caller's final color/depth. Disposal releases owned draw resources and intermediates; disposal is idempotent and leaves source materials, meshes, textures, and final outputs alive. Asynchronous preparation that completes after disposal (helper imports, NodeMaterial shadow sampling code) neither allocates nor publishes GPU resources.

## Babylon.js Equivalence Map

The reference is `FrameGraphGlowLayerTask`/`FrameGraphBaseLayerTask`: one public compound task, explicit destination/output, independent emissive depth, two Gaussian blur levels, direct additive composition. Generic layer/stencil/observable/rendering-group infrastructure is intentionally absent.

## Compat GlowLayer

`new GlowLayer(name, scene?, options?)` is a small facade over the native task, not an EffectLayer subclass. Without an explicit scene it uses the last scene of the last-created compat engine. Initialization runs in the existing engine late-work phase, after the main scene has built its materials and default render task.

Constructor options preserve the Babylon names/defaults listed above, plus `camera`. Optional Lite extensions `targetTexture`, `resolveTexture`, and `afterTask` explicitly place the effect in an application-owned chain. Without these extensions the facade uses the known `scene.defaultRenderTask` output binding and inserts immediately after that producer. It does not search for a final resolver, rewrite SSAO, or automatically follow later target/layout changes. A changed output during asynchronous preparation fails explicitly rather than attaching a stale target.

The facade provides `intensity`, `isEnabled`, `blurKernelSize`, `neutralColor`, `camera`, `ldrMerge`, `alphaBlendingMode`, `getScene()`, `getClassName()`, `isReady()`, inclusion/exclusion methods, `hasMesh()`, `setExcludedByDefault()` and idempotent `dispose()`. Disposal removes the task before releasing its resources; scene disposal invokes the same path. Disposal while preparation is pending prevents task attachment.

Callbacks have four arguments `(mesh, subMesh, material, result)` for color and three `(mesh, subMesh, material)` for texture. Mesh and material are canonical compat wrappers; a single reusable compat `Color4` supports `result.set(...)`. Lite has no submesh API, so `subMesh` is explicitly `null`. Callbacks that require submesh data are outside this adapter's contract. A scene-registry lookup supplies mesh wrappers in constant time; no per-frame scene-array search is allowed.

Returning `null` from the texture selector suppresses the native default texture. Non-null selections must already have a ready 2D native texture; otherwise the adapter reports a `LiteCompatError`. The texture selector runs before the user color selector, matching Babylon. The default Standard texture's level affects default color, but a custom texture selector or custom color selector does not inherit that level multiplication. Without user selectors, the bridge returns before any wrapper lookup unless the native Standard material has an emissive texture.

Inclusion lists take precedence over exclusions, matching Babylon's list selection; the facade translates this to the native task's sets. With `excludeByDefault`, an empty inclusion list renders nothing. A camera-specific layer is gated off when that camera is not the scene's active camera, without installing a per-frame scene observer.

Non-default `renderingGroupId`, `mainTextureSamples != 1`, and `generateStencilBuffer: true` are explicitly unsupported: task order belongs to the caller, the emissive map is single-sample, and glow does not need stencil. Compat `NodeMaterial` wrappers are accepted and resolve to their native material, so a connected glow output renders through the material shader. Serialization and the general EffectLayer/ThinXXX hierarchy are not introduced. A headless engine gets an explicitly reported inert facade, not a fake GPU effect.

## Dependencies

Existing frame-graph lifecycle, Gaussian blur task, render-target allocation, shader composer, shared deformation fragments, resource lifetime helpers, camera view-projection and change key, material/renderable version counters.

## Test Specification

Focused nonvisual tests cover output/ownership contracts, supported options, color/texture selection, opaque versus excluded occlusion membership, per-source alpha classification and diffuse sampling, NodeMaterial/ShaderMaterial neutral surfaces (blend mode, topology, culling), NodeMaterial glow-output capture and program reuse, blur chain/kernel changes, merge blend state, fixed-size projection aspect, change-gated uploads and bundle replay, scene-UBO cache invalidation, texture-selector removal, thin-instance removal, floating-origin lights for a camera override, preparation completing after disposal, empty-map pass skipping, late deformation families, PBR primitive winding/topology in both handedness builds (encoded by the loader's own primitive feature), resize and disposal. Pass counts and map sizes are asserted relative to a measured empty frame and an explicit `mainTextureRatio`. Parity scenes compare against the classic Babylon.js `GlowLayer`: scene 356 (Standard/PBR emitters, a NodeMaterial with a striped, vertex-stretched glow output, plain NodeMaterial and Standard occluders; also run through the compat adapter), scene 357 (ShaderMaterial neutral occluder and selector-picked bar, PBR linear emissive texture, unlit PBR occluder) and scene 358 (right-handed twin of 356). Local visual/parity and performance suites remain user/CI-only.

## File Manifest

- `post-process/glow.ts`: public state, compound task and resource ownership.
- `material/glow/glow-source.ts`: source-material interpretation and texture transforms.
- `material/glow/glow-material.ts`: cached emissive shader variants and draw bindings.
- `material/glow/glow-node.ts`: NodeMaterial glow-output programs, bindings and draws.
- `material/glow/glow-merge.ts`: borrowed-target composition and Babylon alpha-mode blend states.
- `material/node/blocks/fragment-output.ts`: captures the FragmentOutput `glow` and `a` expressions in the build state.
- `lab/lite/src/{lite,bjs}/scene356.ts`, `scene357.ts`, `scene358.ts` with `lab/lite/src/shared/scene356-glow.ts` and `scene356-nme.ts`: parity scenes.
