# Inspector Material and Texture Parity Requirements

## 1. Scope and Reference

This feature is the P4 milestone of BabylonJS/Babylon-Lite issue #55. The visual and interaction reference is Babylon.js Inspector v2; no separate mock is required.

The requirements are grounded in the current Babylon Lite root public API:

- Material families reported by `getMaterialFamily`: `standard`, `pbr`, `shader`, and `node`.
- Material textures currently discovered by `getMaterialTextures`, including `Texture2D` values contributed by registered Standard/PBR extensions and Shader/Node inputs. P4's named binding contract additionally covers the Standard `CubeTexture` reflection slot without changing that legacy flat-list contract.
- Public mutation paths including material-family setters, `setShaderUniform`, `setShaderTexture`, `NodeInputHandle`, `markMaterialUboDirty`, `enableMaterialUvTransform`, and `rebuildMaterial`.
- Public texture shapes including `Texture2D`, `DynamicTexture2D`, `HtmlTexture2D`, `Texture2DArray`, `Texture3D`, render-target/depth facades, and `CubeTexture`.

The words **MUST**, **SHOULD**, and **MAY** are normative.

## 0. Approved Pre-Landing API Correction

This section supersedes every conflicting public-contract or ownership statement below. The detailed matrices remain the Inspector product requirements and the record used to implement T-06–T-29; they no longer prescribe an Inspector-shaped Lite API.

- **REQ-CORR-1:** The Lite root MUST expose narrow domain accessors for material source/family state, Standard optional texture slots, PBR optional families/modes, declared Shader uniform/sampler values, and safe texture metadata/transforms. Stored configuration objects and tuples MUST be returned by identity through compile-time readonly contracts; getters MUST NOT defensively copy or freeze them. Texture wrapper identity is likewise preserved.
- **REQ-CORR-2:** The Lite root declaration MUST expose no `Inspection` type/function, material texture-binding descriptor, UI section/label/property ID, direction/access state, mutation class, post-mutation result, or generic Inspector mutation dispatcher.
- **REQ-CORR-3:** Inspector MUST construct all descriptors and own labels, sections, supported access/directions, mutation and rebuild planning, scene-consumer discovery, selection identity, error and pending state, refresh, and lifecycle.
- **REQ-CORR-4:** `setTextureTransform` MUST validate and write only the exact supplied wrapper and report whether its effective transform changed. It MUST NOT discover consumers, enable material features, dirty UBOs, or rebuild scenes.
- **REQ-CORR-5:** Existing material setters, Node input handles, `setShaderUniform`, `setShaderTexture`, `markMaterialUboDirty`, `enableMaterialUvTransform`, and `rebuildMaterial` remain the public mutation building blocks. Lite MUST NOT replace them with a generic dispatcher.
- **REQ-CORR-6:** `getMaterialTextures()` MUST unwrap `MaterialView` and enumerate public fields/domain getters, Shader declarations, and Node input handles directly in legacy order. It MUST NOT depend on optional-extension registries, descriptors, or raw GPU scans.
- **REQ-CORR-7:** `TextureMetadata` MUST contain only safe optional facts observable from the texture wrapper and GPU texture. It MUST NOT read device-recovery sources. Unknown creation provenance and opaque sampler descriptors are omitted; raw GPU handles, private field names, UI state, labels, directions, and mutation semantics are forbidden.
- **REQ-CORR-8:** Domain accessor modules MUST be side-effect-free and unused root imports MUST emit byte-identical code.
- **REQ-CORR-9:** `rebuildMaterial` MUST return `void | Promise<void>` according to whether the rebuild schedules asynchronous work. Synchronous setup failures MUST throw. Asynchronous failures MUST reject the returned promise without being consumed internally.

### Capability legend

The coverage matrices use:

- **D** — display the current value.
- **E** — edit through a supported public mutation path.
- **N** — navigate to the referenced texture.
- **Omit** — do not render a control or synthetic value.
- **U** — a successful edit must update material uniform state through the family-specific setter or `markMaterialUboDirty`.
- **R** — a successful edit must use the applicable public setter and rebuild all affected renderables through `rebuildMaterial`.
- **A** — the public API owns invalidation (for example, `setShaderUniform`); Inspector must not duplicate private bookkeeping.
- **RO** — read-only.

Where a feature-presence boundary is involved, a property marked **U/R** uses **U** while the compiled feature set remains unchanged and **R** when the edit adds, removes, enables, or disables a shader/resource feature.

## 2. Product Behavior

- **REQ-SCOPE-1:** The Lite material and texture experience MUST use the same Inspector v2 Explorer, Properties pane, section, property-line, selection, watch-mode, and error-boundary conventions as the Babylon.js experience.
- **REQ-SCOPE-2:** Lite controls MUST be labeled and grouped according to their nearest Inspector v2 equivalents, while preserving Lite terminology where its public model differs (for example, `ORM`, `UV1`/`UV2`, and material family names).
- **REQ-SCOPE-3:** A Babylon.js-only property MUST be omitted for a Lite entity unless a public Lite API gives it real, rendering-effective semantics. It MUST NOT be displayed as a fabricated default, inert control, or private-field value.
- **REQ-SCOPE-4:** Material and texture inspection MUST preserve Lite's pure-state and one-way ownership model. No material or texture may receive a back-reference to a scene, engine, Inspector service, or UI object.
- **REQ-SCOPE-5:** The feature MUST work through `@babylonjs/lite`'s root package export only. It MUST NOT add a package subpath export.
- **REQ-SCOPE-6:** Inspector integration MUST NOT expose, accept, compare, or derive identity from `GPUTexture`, `GPUTextureView`, `GPUSampler`, `GPUBuffer`, `GPUDevice`, or another raw WebGPU handle.

## 3. Public Inspection Contracts

- **REQ-API-1:** Lite MUST provide public, typed, side-effect-free inspection contracts sufficient to identify a supported material or texture without `instanceof`, `_buildGroup`, `_texture`, `_view`, `_sampler`, another `@internal` member, or property-shape duck typing.
- **REQ-API-2:** Material inspection MUST expose a stable family, display name, property capabilities, and named texture bindings. Each binding MUST identify its semantic slot, current value or empty state, accepted texture kind, navigation capability, and separately supported assignment, replacement, and clear directions.
- **REQ-API-3:** Named texture binding discovery MUST preserve one entry per semantic slot even when several slots reference the same texture, and MUST include the Standard `CubeTexture` reflection binding. The legacy `getMaterialTextures` behavior MUST remain compatible for callers that only need the flat non-null `Texture2D` list.
- **REQ-API-4:** Texture inspection MUST expose, where applicable, a stable kind, dimensions, depth/layer count, sample category, mipmap availability, color-space classification, render-target/dynamic capability, orientation, and editable UV-transform values without exposing GPU resources.
- **REQ-API-5:** Public inspection values MUST distinguish “unsupported”, “supported but absent”, and an actual false/zero/empty value. Inspector MUST not infer one from another.
- **REQ-API-6:** Public inspection and mutation helpers MUST accept `MaterialView` values by resolving them to their source material. They MUST preserve the existing behavior of `getMaterialFamily`, `getMaterialTextures`, and material type guards.
- **REQ-API-7:** A mutation contract that needs scene ownership MUST receive the relevant `SceneContext` explicitly. It MUST NOT discover the scene through a material/texture private field or mutate the entity to cache ownership.
- **REQ-API-8:** Inspector-facing public APIs MUST remain usable by non-Inspector consumers and MUST have deterministic results independent of optional-extension registration order.

## 4. Runtime-Neutral Inspector Components and Adapters

- **REQ-ADAPT-1:** Shared Inspector v2 material-property, texture-binding, and metadata-only texture-properties components used by P4 MUST consume runtime-neutral values and capability adapters. Shared component cores MUST NOT import Babylon.js `core/*` classes or `@babylonjs/lite` types.
- **REQ-ADAPT-2:** Babylon.js and Lite runtime adapters MUST translate their native representations to the same P4 property-component contracts while preserving each runtime's mutation and invalidation semantics.
- **REQ-ADAPT-3:** Tuple/object conversion MUST reuse the existing controlled-core plus runtime-adapter pattern used by Vector2/Vector3/Vector4 and color property lines. A shared component MUST not require Lite to imitate mutable Babylon.js classes.
- **REQ-ADAPT-4:** A shared material-texture property line MUST obtain candidate textures, display names, accepted kinds, current selection, supported assignment/replacement/clear directions, write-back, and link navigation through an adapter rather than a Babylon.js `Scene`, `BaseTexture`, or class test.
- **REQ-ADAPT-5:** A shared metadata-only texture-properties component MUST obtain identity, characteristics, transforms, and mutation capabilities through an adapter. Unsupported controls MUST be omitted or rendered explicitly read-only according to the adapter capability; they MUST NOT fail after interaction.
- **REQ-ADAPT-6:** P4 MUST NOT extract, introduce, or refactor a runtime-neutral texture-preview component boundary. That extraction and all associated Lite preview capabilities are deferred entirely to P11b.
- **REQ-ADAPT-7:** P4 MUST NOT extract, introduce, or refactor a runtime-neutral texture-editor component boundary. That extraction and all associated Lite pixel-edit, resize, reset, upload, save, and export capabilities are deferred entirely to P11b.
- **REQ-ADAPT-8:** P4 MUST expose no Lite “Preview”, “Edit Texture”, pixel-edit, resize, reset, upload, save, or export action, including disabled or placeholder actions. Existing Babylon.js preview/editor components MUST remain outside the P4 adapter work and unchanged by P4.
- **REQ-ADAPT-9:** Failures and capability changes in the runtime-neutral P4 material/texture property adapters MUST be represented as component state. Shared property UI MUST not silently swallow an error or leave an action enabled when the adapter cannot complete it.
- **REQ-ADAPT-10:** The Babylon.js Inspector entry MUST NOT load Lite runtime code, and the Lite Inspector entry MUST NOT load Babylon.js material/texture implementations merely to reuse UI.

## 5. Discovery, Identity, Naming, and Navigation

- **REQ-DISC-1:** A scene's material list MUST contain each non-null source material referenced by its meshes exactly once, in first mesh-reference order. Multiple `MaterialView` instances of the same source MUST not create duplicate source-material rows.
- **REQ-DISC-2:** A scene's texture list MUST contain each discoverable bound texture exactly once by object identity, in first material and canonical slot order. A texture shared by several materials or slots MUST have one Explorer row.
- **REQ-DISC-3:** Explorer node identity MUST remain stable for the lifetime of the inspected object, including after renames, external property changes, material reordering, and texture sharing changes. Inspector-owned identity MUST not be written onto Lite entities.
- **REQ-DISC-4:** Material display names MUST use a non-empty public `name` when present and otherwise use `<Capitalized family> Material`; an unknown family MUST use `Material`.
- **REQ-DISC-5:** Texture display names MUST use an explicit public display name when one exists and otherwise use a deterministic `<Kind> Texture <ordinal> (<width> × <height>[ × <depth/layers>])` fallback. The ordinal MUST be stable while the texture remains in the scene snapshot.
- **REQ-DISC-6:** Every non-null material texture slot marked **N** in the coverage matrix MUST provide a keyboard- and pointer-activatable link that selects the exact referenced texture in the existing selection service.
- **REQ-DISC-7:** Empty texture slots MUST display the Inspector v2 empty state when assignment is supported, must have no navigation action, and must not create a texture Explorer row. A populated slot MUST offer an empty selection only when its public binding capability explicitly supports safe clearing.
- **REQ-DISC-8:** Returning from a linked texture to the material MUST use the existing Inspector selection/history behavior; navigation MUST not create a cloned or wrapped selection entity.
- **REQ-DISC-9:** Unknown future material families MUST remain selectable and show the common identity section, but MUST expose no family-specific controls until a public adapter declares support.
- **REQ-DISC-10:** A null mesh material, disposed resource, malformed third-party material-like object, or stale selection MUST not crash Explorer or Properties rendering.

## 6. Material Coverage

### 6.1 Common behavior

- **REQ-MAT-1:** Every recognized material MUST display editable `name` and read-only family. `metadata`, renderer internals, cached feature bits, UBO versions, compiled sources, buffers, plugins, and raw resources MUST be omitted.
- **REQ-MAT-2:** Numeric editors MUST reject `NaN` and infinities and MUST enforce the documented public range where one exists. Colors/vectors MUST preserve all components in linear space unless Inspector v2 explicitly labels a display-space conversion.
- **REQ-MAT-3:** A material texture selector MAY select only a texture that is compatible with the slot's public type and sample/view dimension. It MUST expose only the assignment, replacement, and clear directions reported by the public binding capability. Invalid or unsupported-direction assignments MUST be rejected before mutation and explained to the user.
- **REQ-MAT-4:** A texture-binding edit MUST use the current public family setter when one exists. Direct writes to `_emissiveTexture`, `_bumpTexture`, `_clearCoat`, `_textureSlots`, or any other internal backing field are forbidden. P4 MUST NOT add a clear/unset API solely to make an unsupported Inspector direction editable.

### 6.2 Standard material

The following is the complete P4 Standard-material coverage:

| Requirement | Inspector section | Lite property or semantic slot                                                                            | Behavior                                                                                                                                  | Mutation                                                           |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| REQ-STD-1   | General           | `name`, family                                                                                            | D/E for name; D for family                                                                                                                | A / RO                                                             |
| REQ-STD-2   | General           | `backFaceCulling`, `disableLighting`                                                                      | D/E                                                                                                                                       | R                                                                  |
| REQ-STD-3   | Transparency      | `alpha`                                                                                                   | D/E                                                                                                                                       | U/R when crossing the opaque/blended feature boundary              |
| REQ-STD-4   | Transparency      | `alphaCutOff`                                                                                             | D/E                                                                                                                                       | U                                                                  |
| REQ-STD-5   | Lighting & Colors | `diffuseColor`, `specularColor`, `emissiveColor`, `ambientColor`                                          | D/E                                                                                                                                       | U                                                                  |
| REQ-STD-6   | Lighting & Colors | `specularPower`                                                                                           | D/E, minimum 0                                                                                                                            | U                                                                  |
| REQ-STD-7   | Textures          | diffuse, emissive, bump, specular, ambient, lightmap, opacity, 2D reflection slots                        | D/N; E only for assignment, replacement, or clearing directions safely supported by the current public setter; absent slots display empty | R, using the corresponding public Standard setter where one exists |
| REQ-STD-8   | Textures          | cube reflection slot                                                                                      | D/N; accepts `CubeTexture` only; E only for directions safely supported by `setStandardReflectionCubeTexture`; absent slot displays empty | R through `setStandardReflectionCubeTexture`                       |
| REQ-STD-9   | Texture Settings  | `diffuseCoordIndex`, `specularCoordIndex`, `ambientCoordIndex`, `lightmapCoordIndex`                      | D/E as UV1 or UV2                                                                                                                         | R                                                                  |
| REQ-STD-10  | Texture Settings  | `bumpLevel`, `ambientTexLevel`, `lightmapLevel`, `opacityLevel`, `reflectionLevel`, `reflectionCoordMode` | D/E                                                                                                                                       | U                                                                  |
| REQ-STD-11  | Texture Settings  | `useLightmapAsShadowmap`, `opacityFromRGB`                                                                | D/E                                                                                                                                       | R                                                                  |
| REQ-STD-12  | Transform         | `uvScale`, `uvOffset` and enabled per-texture transform values                                            | D/E                                                                                                                                       | R for Standard consumers                                           |
| REQ-STD-13  | Stencil           | public `StencilState` compare/operations/read mask/write mask                                             | D/E when stencil support can be enabled through public API                                                                                | R                                                                  |

Standard properties present only in Babylon.js, including refraction, detail/decal maps, wireframe, point-cloud mode, side orientation, logarithmic depth, texture repetition, and other full-engine render toggles, MUST be omitted.

### 6.3 PBR material

The following is the complete P4 PBR-material coverage:

| Requirement | Inspector section         | Lite property or semantic slot                                                                                                                 | Behavior                                                                                                                                  | Mutation                                                                                             |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| REQ-PBR-1   | General                   | `name`, family                                                                                                                                 | D/E for name; D for family                                                                                                                | A / RO                                                                                               |
| REQ-PBR-2   | General                   | `doubleSided`, `alphaBlend`, `enableSpecularAA`                                                                                                | D/E                                                                                                                                       | R                                                                                                    |
| REQ-PBR-3   | Transparency              | `alpha`                                                                                                                                        | D/E, range 0–1                                                                                                                            | U/R when blend classification changes                                                                |
| REQ-PBR-4   | Transparency              | alpha cutoff configured by `setPbrAlphaCutoff`                                                                                                 | D/E when present                                                                                                                          | U/R when alpha-test presence changes                                                                 |
| REQ-PBR-5   | Lighting & Colors         | `baseColorFactor`                                                                                                                              | D/E as linear RGBA                                                                                                                        | U/R when optional-factor presence changes                                                            |
| REQ-PBR-6   | Lighting & Colors         | emissive color configured by `setPbrEmissive`                                                                                                  | D/E when present                                                                                                                          | U/R when emissive feature presence changes                                                           |
| REQ-PBR-7   | Lighting & Colors         | `environmentIntensity`, `directIntensity`, `reflectance`, `metallicFactor`, `roughnessFactor`, `normalTextureScale`, `usePhysicalLightFalloff` | D/E                                                                                                                                       | U                                                                                                    |
| REQ-PBR-8   | Textures                  | base color, normal, ORM, separate occlusion, emissive, specular-glossiness slots                                                               | D/N; E only for assignment, replacement, or clearing directions safely supported by the current public setter; absent slots display empty | R                                                                                                    |
| REQ-PBR-9   | Occlusion                 | `occlusionStrength`                                                                                                                            | D/E, range 0–1                                                                                                                            | U/R when crossing the enabled boundary                                                               |
| REQ-PBR-10  | Occlusion                 | `occlusionTexCoord`                                                                                                                            | D only until a public setter maintains the required UV2 claim                                                                             | RO                                                                                                   |
| REQ-PBR-11  | Lightmap                  | texture, level, UV set, shadowmap mode, gamma decode                                                                                           | D/E/N when enabled, except clearing MUST remain unavailable                                                                               | U/R through the existing `enablePbrLightmap` and `setPbrLightmap`; no clear/unset API is added in P4 |
| REQ-PBR-12  | Metallic Reflectance      | color, F0 factor, specular weight, metallic-only flag, metallic-reflectance texture, reflectance texture                                       | D/E and N for textures when configured                                                                                                    | U/R through `setPbrMetallicReflectance`                                                              |
| REQ-PBR-13  | Clear Coat                | enabled, intensity, roughness, index of refraction, F0 remap, intensity/roughness/bump textures, bump scale                                    | D/E and N for textures when configured                                                                                                    | U/R through `setPbrClearCoat`                                                                        |
| REQ-PBR-14  | Sheen                     | enabled, color, roughness, intensity, albedo scaling, color/roughness textures                                                                 | D/E and N for textures when configured                                                                                                    | U/R through `setPbrSheen`                                                                            |
| REQ-PBR-15  | Iridescence               | enabled, intensity, index of refraction, min/max thickness, intensity/thickness textures                                                       | D/E and N for textures when configured                                                                                                    | U/R through `setPbrIridescence`                                                                      |
| REQ-PBR-16  | Anisotropy                | enabled, intensity, direction, texture                                                                                                         | D/E and N for texture when configured                                                                                                     | U/R through `setPbrAnisotropy`                                                                       |
| REQ-PBR-17  | Subsurface / Translucency | intensity, color, diffusion distance, color/intensity textures                                                                                 | D/E and N for textures when configured                                                                                                    | U/R through `setPbrSubsurface`                                                                       |
| REQ-PBR-18  | Subsurface / Thickness    | min, max, glTF-channel mode, texture                                                                                                           | D/E and N for texture when configured                                                                                                     | U/R through `setPbrSubsurface`                                                                       |
| REQ-PBR-19  | Subsurface / Tint         | color, distance                                                                                                                                | D/E when configured                                                                                                                       | U/R through `setPbrSubsurface`                                                                       |
| REQ-PBR-20  | Transmission              | intensity, index of refraction, use-thickness-as-depth, texture                                                                                | D/E and N for texture when configured                                                                                                     | U/R through `setPbrTransmission`                                                                     |
| REQ-PBR-21  | Transmission              | dispersion                                                                                                                                     | D/E when configured                                                                                                                       | U/R through `setPbrDispersion`                                                                       |
| REQ-PBR-22  | Special Modes             | one-way unlit/tint, gamma-albedo, skybox, and shadow-only/color/opacity/falloff state                                                          | D when configured                                                                                                                         | RO; P4 adds no reversible setters                                                                    |
| REQ-PBR-23  | Transform                 | enabled per-texture `uScale`, `vScale`, `uOffset`, `vOffset`, `uAng`                                                                           | D/E                                                                                                                                       | `enableMaterialUvTransform`, then U for PBR consumers; R if enabling after compilation               |
| REQ-PBR-24  | Stencil                   | public `StencilState` compare/operations/read mask/write mask                                                                                  | D/E when stencil support can be enabled through public API                                                                                | R                                                                                                    |

The reserved, non-rendering `ScatteringProps` path, local-environment probe internals, extension registry data, and Babylon.js-only PBR properties MUST be omitted.

### 6.4 Shader material

| Requirement | Inspector section | Lite property or semantic slot                                                                                                                              | Behavior                                       | Mutation                                                                       |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| REQ-SHD-1   | General           | `name`, family                                                                                                                                              | D/E for name; D for family                     | A / RO                                                                         |
| REQ-SHD-2   | Inputs            | declared non-system `f32`, `u32`, `i32`, `vec2<f32>`, `vec3<f32>`, `vec4<f32>`, and `mat4x4<f32>` uniforms                                                  | D/E with a control matching declared type      | A through `setShaderUniform` or its public typed wrappers                      |
| REQ-SHD-3   | Textures          | every declared sampler's name, sample type, view dimension, and current texture                                                                             | D/E/N; nullable                                | A through `setShaderTexture`; assignment errors leave the old texture selected |
| REQ-SHD-4   | Configuration     | attributes, defines, blend mode/state, transmissive, alpha testing, culling, depth write/compare, depth-only fragment, depth bias, slope bias, and topology | D                                              | RO                                                                             |
| REQ-SHD-5   | Inputs            | system uniforms and storage-buffer values                                                                                                                   | Omit; declaration names MAY be shown read-only | RO                                                                             |

WGSL source editing, define editing, storage-buffer inspection, pipeline recompilation, and material-specific interpretation of custom uniforms are out of P4.

### 6.5 Node material

| Requirement | Inspector section | Lite property or semantic slot                                                  | Behavior                                          | Mutation                                    |
| ----------- | ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| REQ-NODE-1  | General           | `name`, family                                                                  | D/E for name; D for family                        | A / RO                                      |
| REQ-NODE-2  | Inputs            | every public named `f32`, `vec2f`, `vec3f`, and `vec4f` `NodeInputHandle.value` | D/E using scalar/vector/color-compatible controls | A through `NodeInputHandle.value`           |
| REQ-NODE-3  | Inputs            | every public named `texture2d` `NodeInputHandle.texture`                        | D/E/N; nullable                                   | R after assigning through the public handle |
| REQ-NODE-4  | Inputs            | input key and declared `NodeInputHandle.type`                                   | D in deterministic key order                      | RO                                          |

Node graph structure, unnamed/constant blocks, visibility/group metadata not exposed by `NodeInputHandle`, generated WGSL, and Node Material Editor launch are out of P4.

## 7. Texture Coverage

- **REQ-TEX-1:** Texture properties MUST use the public texture inspection discriminator from REQ-API-1; the current check for `width`, `height`, `texture`, `view`, and `sampler` is forbidden.
- **REQ-TEX-2:** All discovered texture kinds MUST display a type label and dimensions. Optional characteristics MUST appear only when the inspection contract reports them.
- **REQ-TEX-3:** UV-transform edits MUST be offered only when at least one selected material consumer applies Lite's standard texture-transform semantics. Editing a transform MUST invalidate every affected consumer in the selected `SceneContext`.
- **REQ-TEX-4:** `invertY` MUST be display-only in P4. Inspector MUST NOT reinterpret upload-time orientation or mutate it without a public API that can preserve existing texels and sampling semantics.
- **REQ-TEX-5:** Sampler address/filter state, texture format, sample category, mip availability, color space, dimensions, array layers, and 3D depth MUST be display-only in P4.
- **REQ-TEX-6:** A cloned wrapper and its base MAY have different transform values and MUST therefore remain distinct selectable entities even when they share backing resources. GPU-resource equality MUST never be used for deduplication.
- **REQ-TEX-7:** A texture that is present in more than one slot or material MUST report all known consumer locations without duplicating its Explorer row.

| Requirement | Public texture kind / origin                                                                 | Required P4 properties                                                                                                                                      | Edit / navigation                                                                | Preview / editor in P4                                           |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| REQ-TK-1    | Ordinary 2D: URL raster, KTX/Basis/KTX2, solid, pixel, external-image, or cloned `Texture2D` | Kind/source category when known, width, height, orientation, sample/color-space/mipmap/sampler characteristics when known, UV transform                     | D; E for applicable transforms; N from every binding                             | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-2    | `DynamicTexture2D`                                                                           | Kind, width, height, dynamic/updateable capability, characteristics, UV transform                                                                           | D; E for applicable transforms; N                                                | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-3    | `HtmlTexture2D`                                                                              | Kind, width, height, readiness/update capability without exposing its DOM element, characteristics, UV transform                                            | D; E for applicable transforms; N                                                | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-4    | Render-target or sampled-depth `Texture2D` facade                                            | Kind, current width/height, render-target/depth capability, characteristics                                                                                 | D; N                                                                             | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-5    | `Texture2DArray`                                                                             | Kind, width, height, layer count, characteristics                                                                                                           | D; N from compatible Shader slots                                                | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-6    | `Texture3D`                                                                                  | Kind, width, height, depth, characteristics                                                                                                                 | D; N if a future/current public material binding exposes it                      | None; component extraction and Lite actions are deferred to P11b |
| REQ-TK-7    | `CubeTexture` used by Standard reflection                                                    | Metadata-only Properties page with kind and every safe public characteristic reported by the inspection contract; no transform, preview, or editor controls | D; N from the cube-reflection binding to the exact `CubeTexture` Explorer entity | None; component extraction and Lite actions are deferred to P11b |

Texture allocation origin MUST NOT be guessed when the current public object cannot prove it. In that case the kind is the least-specific valid public kind, such as `2D Texture`.

## 8. Editing, Invalidation, and Shared Resources

- **REQ-MUT-1:** Every editable row MUST declare one mutation class from the matrices, and component code MUST delegate the write to the Lite adapter rather than assigning generically through Babylon.js property instrumentation.
- **REQ-MUT-2:** A **U** edit MUST update the source material and call `markMaterialUboDirty` exactly once unless the called public setter already owns equivalent invalidation.
- **REQ-MUT-3:** An **R** edit MUST update through the public setter where available, then call `rebuildMaterial` for every owning scene in which the source material is used. Rebuilds MUST include views of the source and MUST rebuild the frame graph when the edited feature changes frame-graph participation.
- **REQ-MUT-4:** An **A** edit MUST use its public mutation API and MUST NOT mutate its internal storage or version counters. This includes Shader uniform/texture setters and Node input accessors.
- **REQ-MUT-5:** Feature-presence and texture-binding edits MUST not silently set an internal backing field. When a current public API cannot safely enable, disable, assign, replace, or clear a feature or slot, Inspector MUST keep that direction unavailable while preserving any independently supported directions. P4 MUST NOT add clear/unset APIs or reversible mode setters to manufacture symmetry.
- **REQ-MUT-6:** Editing a texture object's UV transform MUST locate all material consumers in the current scene by public binding discovery and apply the correct U/R invalidation to each unique source material once.
- **REQ-MUT-7:** Replacing one material texture binding MUST affect only that semantic slot. It MUST NOT mutate or dispose the previous texture, alter another material's binding, or change a shared texture's properties.
- **REQ-MUT-8:** Shared source materials and their `MaterialView` renderables MUST converge on the same edited value. Rebuild/UBO invalidation MUST update every view unless the public call explicitly requests otherwise.
- **REQ-MUT-9:** Successful edits MUST become visible no later than the next rendered frame and the next Inspector refresh. Repeatedly committing the same value MUST not cause unbounded rebuild or UBO-version churn.
- **REQ-MUT-10:** A failed validation, setter, asynchronous enablement, or rebuild MUST leave the last valid value represented in the UI and MUST surface an actionable error without corrupting selection or other consumers.

## 9. Runtime Refresh and Lifecycle

- **REQ-REFRESH-1:** In polling mode, externally changed material names, supported scalar/vector/color values, texture bindings, texture transforms, dimensions, and capabilities MUST update without reselecting the entity. Manual refresh MUST produce the same result immediately.
- **REQ-REFRESH-2:** Adding, removing, swapping, or sharing a mesh material or a material texture at runtime MUST update the Explorer topology on the next refresh while preserving identity and selection for entities that remain present.
- **REQ-REFRESH-3:** Property components MUST re-evaluate capability-dependent rows when a feature object or texture binding appears, disappears, or changes kind.
- **REQ-REFRESH-4:** If the selected material or texture is no longer reachable from the selected scene, Inspector MUST either retain a clearly marked detached read-only selection or clear it according to the existing selection-service convention; it MUST not continue offering scene-dependent edits.
- **REQ-REFRESH-5:** Asynchronous adapter results MUST be associated with the entity and request generation that initiated them. Late completion after selection change, close, or disposal MUST not overwrite the current UI.
- **REQ-REFRESH-6:** All watchers, subscriptions, pending operations, and adapter-owned resources MUST be released when their section, Inspector instance, or inspected engine is disposed.

## 10. Accessibility and Error Handling

- **REQ-A11Y-1:** Every displayed value, editor, texture link, and capability action MUST have an accessible name matching its visible Inspector v2 label.
- **REQ-A11Y-2:** All property editing, section expansion, texture linking, and error dismissal MUST be operable by keyboard alone and MUST expose focus and disabled state through standard semantics.
- **REQ-A11Y-3:** Texture links MUST identify both the slot and destination in their accessible name; empty or unavailable links MUST not be focusable.
- **REQ-A11Y-4:** Validation and adapter failures MUST be announced through an accessible status/error region, and focus MUST remain on or return to the control that caused the failure.
- **REQ-A11Y-5:** Color, vector, numeric, switch, and selector controls MUST retain the established Inspector v2 labeling, contrast, focus, and screen-reader behavior after introducing the runtime-neutral P4 material/texture property adapters.
- **REQ-ERR-1:** Unknown families, unknown texture kinds, missing optional metadata, null bindings, zero-sized/transient render targets, and not-yet-ready dynamic resources MUST render a safe explicit fallback rather than throw.
- **REQ-ERR-2:** Inspector MUST not log routine unsupported-state errors to the console. Unexpected adapter failures MAY be logged once and MUST also be presented in the affected UI boundary.
- **REQ-ERR-3:** Invalid texture-kind assignments and invalid numeric edits MUST be rejected before any Lite mutation or rebuild is initiated.

## 11. Tree-Shaking and Package Isolation

- **REQ-SIZE-1:** A representative application that does not import or enable Inspector integration MUST have exactly zero additional runtime-loaded JavaScript bytes and zero additional fetched chunks because of this feature.
- **REQ-SIZE-2:** New Lite inspection helpers MUST have no module-level registrations, global mutations, or eager `Map`, `Set`, or `WeakMap` allocations. Optional caches MUST be lazy and removable with the importing feature.
- **REQ-SIZE-3:** Material-family-specific and metadata-only texture-properties code MUST be loaded only when the corresponding Inspector capability is used. P4 material/texture property components and Lite adapters MUST NOT import or load preview/editor tooling.
- **REQ-SIZE-4:** The Lite Inspector entry MUST not retain Babylon.js engine/material/texture modules. The Babylon.js Inspector entry MUST not retain `@babylonjs/lite`.
- **REQ-SIZE-5:** P4 MUST not change bundle-size ceilings. Any non-zero runtime-byte delta in a representative non-Inspector Lite application is a defect, not a new baseline.

## 12. Verification

- **REQ-TEST-1:** Focused Lite unit tests MUST cover every recognized/unknown material family, `MaterialView` unwrapping, canonical named texture bindings, null slots, duplicate/shared textures, and each public texture kind in the texture matrix.
- **REQ-TEST-2:** Focused Inspector v2 component/service tests MUST verify the D/E/N behavior and omitted controls for every row in the material matrices.
- **REQ-TEST-3:** Mutation tests MUST assert the selected public setter and exactly the required U, R, or A invalidation path for every supported mutation direction, including supported feature-boundary transitions, views, frame-graph-affecting transmission, and multiple consumers of one texture. They MUST also verify that unsupported clear/unset directions and one-way PBR mode edits are unavailable and invoke no mutation.
- **REQ-TEST-4:** Runtime tests MUST verify external changes in both manual and polling watch modes, topology refresh after material/texture swaps, stable identity after rename/reorder, and safe disposal during a pending operation.
- **REQ-TEST-5:** Adapter contract tests MUST run the shared P4 material-property, texture-binding, and metadata-only texture-properties components against both Babylon.js and Lite adapters. Existing Babylon.js property behavior MUST remain green.
- **REQ-TEST-6:** Static/component tests MUST verify that P4 introduces no runtime-neutral preview/editor boundary, leaves existing Babylon.js preview/editor components unchanged, exposes no Lite preview/editor action or placeholder, and imports no preview/editor tooling from P4 property components or Lite adapters.
- **REQ-TEST-7:** Accessibility tests MUST cover keyboard operation, accessible names/states, texture-link focus behavior, and announced validation/adapter errors.
- **REQ-TEST-8:** Focused package/build tests MUST prove root-only exports, trimmed `@internal` declarations, absence of raw GPU types from new public inspection contracts, and zero runtime-loaded-byte growth in applications that do not enable Inspector.
- **REQ-TEST-9:** This feature MUST NOT require visual/parity golden updates, local visual/parity runs, all-scene test runs, or bundle-size ceiling changes.

## 13. Out of Scope

- Runtime-neutral texture preview/editor component extraction and all Lite texture pixel preview, channel/face/layer/slice/LOD readback, texture painting, resize, upload, reset, save, and export behavior. These are deferred entirely to P11b; P4 introduces neither the boundaries nor Lite actions/placeholders for them.
- Creating a Lite texture readback API solely to make P4 show a preview.
- New texture-slot clear/unset APIs or reversible setters for currently one-way PBR modes solely to make Inspector controls bidirectional.
- New rendering features, new material families, or Babylon.js-only properties added solely for Inspector appearance.
- PBR scattering UI while `ScatteringProps` remains reserved and has no rendering implementation.
- Node Material graph editing or launching the Node Material Editor.
- Shader source, shader define, storage-buffer, GPU-pipeline, bind-group, or raw-resource inspection/editing.
- Texture-debug replacement materials, render-output overrides, or material channel soloing.
- PBR environment-probe/cubemap management that is not a material binding returned by the public inspection contract.
- Asset-container, animation, picking/highlighting, gizmo, performance, capture, FrameGraph, FlowGraph, skeleton/morph, particle, physics, audio, extension, CLI, documentation-sample, and other milestones tracked separately in issue #55.
- Any source implementation, task-board update, visual golden change, or bundle-size ceiling update as part of this requirements-writing phase.

## 14. Acceptance Criteria Summary

| Area                 | Requirements                  | Acceptance evidence                                                                                                                              |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope and parity     | REQ-SCOPE-1–6                 | Lite UI follows Inspector v2 conventions and omits unsupported Babylon.js-only state                                                             |
| Public contracts     | REQ-API-1–8                   | Root-public typed API tests; no private/raw-GPU access; deterministic named bindings                                                             |
| Shared components    | REQ-ADAPT-1–10                | Babylon.js and Lite P4 property-adapter tests; no cross-runtime imports; no P4 preview/editor extraction or Lite actions                         |
| Discovery/navigation | REQ-DISC-1–10                 | Stable, deduplicated Explorer tests and exact texture-link selection tests                                                                       |
| Standard material    | REQ-STD-1–13                  | Property matrix component tests plus UBO/rebuild mutation tests                                                                                  |
| PBR material         | REQ-PBR-1–24                  | Core and enabled-extension matrix tests, including frame-graph transmission changes and read-only one-way modes                                  |
| Shader material      | REQ-SHD-1–5                   | Typed uniform/sampler tests and read-only configuration tests                                                                                    |
| Node material        | REQ-NODE-1–4                  | Named input value/texture tests and rebuild verification                                                                                         |
| Textures             | REQ-TEX-1–7, REQ-TK-1–7       | Kind/capability/metadata tests, Standard `CubeTexture` navigation, directional slot capabilities, and shared-wrapper/consumer invalidation tests |
| Runtime lifecycle    | REQ-MUT-1–10, REQ-REFRESH-1–6 | Manual/polling refresh, shared-resource, error, stale-async, and disposal tests                                                                  |
| Accessibility        | REQ-A11Y-1–5, REQ-ERR-1–3     | Keyboard and accessibility assertions; explicit error/fallback states                                                                            |
| Isolation and size   | REQ-SIZE-1–5                  | Focused package boundary checks and byte-identical non-Inspector runtime-load measurement                                                        |
| Verification policy  | REQ-TEST-1–9                  | All focused agent-allowed tests green; CI owns visual/parity and repository-wide scene coverage                                                  |

## 15. Resolved Decisions

1. **Cube textures in P4:** Standard cube-reflection bindings are included in named binding discovery, are navigable, and open a metadata-only `CubeTexture` Properties page. The legacy flat `getMaterialTextures` `Texture2D` contract remains compatible.
2. **Texture-slot reassignment:** P4 exposes only mutation directions that current public APIs can perform safely. Unsupported clear/unset directions remain unavailable, and P4 adds no clear/unset APIs.
3. **One-way PBR modes:** Modes backed only by one-way public APIs are displayed read-only. P4 adds no reversible setters.
4. **Preview/editor extraction timing:** Runtime-neutral preview/editor component extraction and all Lite preview/editor actions are deferred entirely to P11b. P4 adapters cover only the material-property, texture-binding, and metadata-only texture-properties UI delivered by P4.
