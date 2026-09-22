# Inspector Material and Texture Parity Architecture

> Feature: `inspector-material-texture-parity` (P4 of BabylonJS/Babylon-Lite issue #55)  
> Status: implemented, with an approved pre-landing API correction
> Scope: Babylon Lite runtime-domain accessors plus Inspector v2-owned descriptors and metadata UI

## Approved Pre-Landing Architecture Correction

T-06–T-29 implemented the architecture documented below, including Lite-owned descriptors and mutation dispatch. Before landing, API review approved a narrower boundary. This correction is authoritative wherever the historical architecture conflicts with it.

| Babylon Lite owns                                                                                                                                                                   | Inspector owns                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side-effect-free material source/family getters, optional Standard/PBR state getters, Shader declaration/value getters, safe texture metadata and exact-wrapper transform accessors | Descriptor construction, property IDs, sections, labels, read/write directions, validation messages, mutation classification and rebuild planning |
| Existing domain setters, Node input handles, `markMaterialUboDirty`, `enableMaterialUvTransform`, and `rebuildMaterial`                                                             | Scene-consumer discovery, source/view indexing, selection/navigation, errors, pending generations, refresh, and lifecycle                         |
| Direct legacy-order `getMaterialTextures()` enumeration from domain state                                                                                                           | Inspector-specific semantic binding IDs and candidate filtering                                                                                   |

Lite publishes no `Inspection*` symbol and no generic Inspector mutation dispatcher. Stored PBR configuration objects, tuples, and Shader uniform arrays are returned by identity through compile-time readonly types, without defensive copies or runtime freezing. `TextureMetadata` is a handle-free optional-fact snapshot. `setTextureTransform` changes only the exact wrapper and returns a boolean; Inspector decides which materials must opt into UV transforms, be dirtied, or be rebuilt. `rebuildMaterial` returns its natural `void | Promise<void>` completion: synchronous setup failures throw and asynchronous failures reject the returned promise without being consumed internally. Node materials continue to expose their public input handles without a parallel descriptor layer.

Migration from `rebuildMaterial(...): void`: callers that ignored the return value need no change; callers that explicitly typed the result as `void` must accept `void | Promise<void>`, and callers that need rebuild completion should use `await rebuildMaterial(...)`.

The `packages/babylon-lite/src/inspection/` implementation described later in this document was removed rather than retained as a hidden duplicate descriptor system. The remainder of this document is the historical design and completion record for the first implementation; its Inspector UI behavior remains useful, but its Lite ownership and public signatures are non-normative.

## 1. Executive Summary

P4 adds a small, root-exported inspection boundary to `@babylonjs/lite` and consumes it through runtime-neutral Inspector v2 components. The Lite package remains the only authority for material family, supported properties, semantic texture slots, texture metadata, validation, and mutation class. Inspector owns only presentation, selection, scene reachability, stable UI identity, refresh scheduling, and operation state.

The design deliberately does **not** make Babylon Lite objects imitate Babylon.js classes. Public snapshots are immutable plain data. Mutations are standalone functions that receive all ownership context explicitly, unwrap `MaterialView` to its source, call existing public family setters/handles, and perform exactly the required UBO or rebuild invalidation. No new scene, engine, Inspector, or UI back-reference is added to a material or texture.

The Standard cube-reflection slot participates in named binding discovery and navigation. A selected `CubeTexture` gets a metadata-only Properties page. The legacy `getMaterialTextures()` result remains a flat, non-null `Texture2D[]` and never contains a cube.

One-way PBR modes remain read-only. Existing APIs that cannot clear a slot do not gain a clear API. Texture preview/editor extraction, readback, upload, resize, reset, save, export, and all Lite actions are wholly deferred to P11b.

All new Lite exports come from the package root. The modules have no import-time registration or eager collections. Inspector loads the Lite material-family component only when such a material is selected and the metadata-only texture component only when such a texture is selected. A build that does not load Inspector must have byte-identical runtime-loaded JavaScript and fetch no new chunk.

## 2. Context and Architectural Delta

### 2.1 Current state

| Area                     | Current behavior                                                                                                         | P4 problem                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Lite material discovery  | `getMaterialFamily()` and `getMaterialTextures()`                                                                        | Flat textures have no semantic slot, empty state, accepted kind, or directional capabilities; cube reflection is absent |
| Lite Inspector Explorer  | Per-scene mesh scan, material `Set`, flattened texture `Set`                                                             | Material views are not canonically collapsed to sources; texture ordering and labels lack slot/kind metadata            |
| Lite material Properties | Editable name and read-only family only                                                                                  | No family-specific Standard, PBR, Shader, or Node controls                                                              |
| Lite texture Properties  | Detects `{ width, height, texture, view, sampler }` by shape                                                             | Uses forbidden raw-resource/duck-typing assumptions and only shows dimensions/orientation                               |
| Mutations                | Mix of direct public state, feature setters, `markMaterialUboDirty`, `rebuildMaterial`, Shader setters, and Node handles | A generic property binding cannot choose or verify U/R/A semantics                                                      |
| Rebuild completion       | `rebuildMaterial()` reports asynchronous failure through runtime hooks and `console.error`                               | Inspector cannot associate completion/failure with a request or restore its committed UI state                          |
| Shared UI                | Controlled vector/color cores exist; material texture selector is Babylon.js-specific                                    | P4 needs runtime-neutral controlled models without extracting preview/editor UI                                         |

### 2.2 Proposed state

| Layer                                | Responsibility                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@babylonjs/lite` inspection modules | Recognize supported entities, normalize safe metadata, enumerate deterministic property/slot capabilities, validate writes, use public family mutation paths, and report U/R/A effects |
| Inspector Lite resource index        | Discover source materials and bound texture objects per scene, maintain Inspector-only identity/ordinals/consumer edges, and provide candidates and owning scenes                      |
| Runtime-neutral shared components    | Render sections, typed controls, texture selectors/links, pending state, and accessible errors from adapter data only                                                                  |
| Lite adapters                        | Translate Lite snapshots to shared component models; invoke Lite mutation functions and selection/watcher services                                                                     |
| Babylon.js adapters                  | Preserve existing Babylon.js behavior while targeting the same shared component contracts                                                                                              |
| Existing Babylon.js preview/editor   | Remains unchanged and outside the P4 dependency graph                                                                                                                                  |

```text
Before
------
Lite scene -> sceneResources -> Texture2D duck typing -> Lite-only property rows
Babylon.js Scene/BaseTexture --------------------------> Babylon.js property rows

After
-----
@babylonjs/lite root
  -> pure inspection snapshots
  -> explicit mutation(scope, source, id, value)
          |
          v
Lite adapter ----\
                  > runtime-neutral property/selector/metadata cores
BJS adapter -----/            |
                               +-> existing selection + watcher services

Babylon.js preview/editor ------------------------------------------+
                                                                   |
                                    unchanged; no edge from P4 <----+
```

## 3. Architectural Rules

1. **Runtime authority stays in Lite.** Inspector never reads `_buildGroup`, `_texture`, `_view`, `_sampler`, feature registries, internal texture slots, UBO counters, or raw WebGPU resources.
2. **UI authority stays in Inspector.** Lite does not depend on React, Fluent UI, Babylon.js core, Inspector services, labels, navigation, or scene-selection state.
3. **State flows one way.** Inspection returns a fresh immutable snapshot. A mutation receives the entity plus an explicit scene scope, changes the source, invalidates it, then Inspector refreshes and renders a new snapshot.
4. **Object identity is not metadata.** Explorer selection is always the original material source or texture wrapper. DTOs are never placed in the selection service.
5. **Capabilities precede controls.** Unsupported, absent, and present values are separate states. A control/action is created only from a reported capability; no click-time “probably unsupported” path exists.
6. **Private implementation knowledge is encapsulated once.** Lite inspection implementations may read package-internal fields required to translate existing objects, but those fields and raw handles never cross the public result type. Inspector performs no duck typing.
7. **No speculative parity.** Babylon.js-only properties and reserved/non-rendering Lite state are omitted.
8. **Opt-in loading is preserved.** New modules contain no registration at evaluation time, no eager `Map`/`Set`/`WeakMap`, and no Inspector import from Lite.

## 4. Public `@babylonjs/lite` Contract

All declarations below are exported from `packages/babylon-lite/src/index.ts`; no package subpath is added. Names are normative for implementation planning. The result types contain only primitives, tuples, readonly records, and references to existing Lite entities. They contain no `GPUTexture`, `GPUTextureView`, `GPUSampler`, `GPUBuffer`, `GPUDevice`, or WebGPU descriptor type.

### 4.1 Capability and value types

```ts
export type InspectionValue<T> = { readonly state: "unsupported"; readonly reason: string } | { readonly state: "absent" } | { readonly state: "present"; readonly value: T };

export type InspectionDatum<T> = { readonly state: "unknown"; readonly reason?: string } | { readonly state: "known"; readonly value: T };

export type MaterialMutationClass = "U" | "R" | "A" | "U/R";
export type AppliedMaterialMutationClass = Exclude<MaterialMutationClass, "U/R">;
export type MaterialPostMutation = "none" | "rebuild-material" | "rebuild-material-and-frame-graph";

export interface InspectionNumberConstraint {
    readonly finite: true;
    readonly integer?: boolean;
    readonly min?: number;
    readonly max?: number;
}

export interface MaterialInspectionEdit {
    readonly access: "read-write";
    readonly mutation: MaterialMutationClass;
    readonly postMutation: MaterialPostMutation;
    readonly number?: InspectionNumberConstraint;
}

export interface MaterialInspectionReadOnly {
    readonly access: "read-only";
    readonly reason?: string;
}

export type MaterialInspectionAccess = MaterialInspectionEdit | MaterialInspectionReadOnly;
```

`absent` means the runtime supports the property/slot but it is not configured. It is not equivalent to `false`, `0`, `""`, or an empty tuple. `unsupported` means no effective public operation/value exists and always carries a user-displayable reason. Optional metadata uses `unknown`, not a guessed value.

### 4.2 Material properties

```ts
export type MaterialInspectionSection =
    | "general"
    | "transparency"
    | "lighting-colors"
    | "textures"
    | "texture-settings"
    | "transform"
    | "occlusion"
    | "lightmap"
    | "metallic-reflectance"
    | "clear-coat"
    | "sheen"
    | "iridescence"
    | "anisotropy"
    | "subsurface-translucency"
    | "subsurface-thickness"
    | "subsurface-tint"
    | "transmission"
    | "special-modes"
    | "inputs"
    | "configuration"
    | "stencil";

export type MaterialInspectionScalar = string | number | boolean;
export type MaterialInspectionTuple =
    | readonly [number, number]
    | readonly [number, number, number]
    | readonly [number, number, number, number]
    | readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
export type MaterialInspectionPropertyValue = MaterialInspectionScalar | MaterialInspectionTuple;

export type MaterialInspectionPropertyId =
    | "material.name"
    | "standard.backFaceCulling"
    | "standard.disableLighting"
    | "standard.alpha"
    | "standard.alphaCutOff"
    | "standard.diffuseColor"
    | "standard.specularColor"
    | "standard.emissiveColor"
    | "standard.ambientColor"
    | "standard.specularPower"
    | "standard.diffuseCoordIndex"
    | "standard.specularCoordIndex"
    | "standard.ambientCoordIndex"
    | "standard.lightmapCoordIndex"
    | "standard.bumpLevel"
    | "standard.ambientTexLevel"
    | "standard.lightmapLevel"
    | "standard.opacityLevel"
    | "standard.reflectionLevel"
    | "standard.reflectionCoordMode"
    | "standard.useLightmapAsShadowmap"
    | "standard.opacityFromRGB"
    | "standard.uvScale"
    | "standard.uvOffset"
    | "standard.stencil.compare"
    | "standard.stencil.passOp"
    | "standard.stencil.failOp"
    | "standard.stencil.depthFailOp"
    | "standard.stencil.readMask"
    | "standard.stencil.writeMask"
    | "pbr.doubleSided"
    | "pbr.alphaBlend"
    | "pbr.enableSpecularAA"
    | "pbr.alpha"
    | "pbr.alphaCutOff"
    | "pbr.baseColorFactor"
    | "pbr.emissiveColor"
    | "pbr.environmentIntensity"
    | "pbr.directIntensity"
    | "pbr.reflectance"
    | "pbr.metallicFactor"
    | "pbr.roughnessFactor"
    | "pbr.normalTextureScale"
    | "pbr.usePhysicalLightFalloff"
    | "pbr.occlusionStrength"
    | "pbr.occlusionTexCoord"
    | "pbr.lightmapLevel"
    | "pbr.lightmapCoordIndex"
    | "pbr.useLightmapAsShadowmap"
    | "pbr.gammaLightmap"
    | "pbr.metallicReflectanceColor"
    | "pbr.metallicF0Factor"
    | "pbr.specularWeight"
    | "pbr.useOnlyMetallicFromTexture"
    | "pbr.clearCoat.enabled"
    | "pbr.clearCoat.intensity"
    | "pbr.clearCoat.roughness"
    | "pbr.clearCoat.indexOfRefraction"
    | "pbr.clearCoat.useF0Remap"
    | "pbr.clearCoat.bumpTextureScale"
    | "pbr.sheen.enabled"
    | "pbr.sheen.color"
    | "pbr.sheen.roughness"
    | "pbr.sheen.intensity"
    | "pbr.sheen.albedoScaling"
    | "pbr.iridescence.enabled"
    | "pbr.iridescence.intensity"
    | "pbr.iridescence.indexOfRefraction"
    | "pbr.iridescence.minimumThickness"
    | "pbr.iridescence.maximumThickness"
    | "pbr.anisotropy.enabled"
    | "pbr.anisotropy.intensity"
    | "pbr.anisotropy.direction"
    | "pbr.translucency.intensity"
    | "pbr.translucency.color"
    | "pbr.translucency.diffusionDistance"
    | "pbr.thickness.min"
    | "pbr.thickness.max"
    | "pbr.thickness.useGlTFChannel"
    | "pbr.tint.color"
    | "pbr.tint.atDistance"
    | "pbr.transmission.intensity"
    | "pbr.transmission.indexOfRefraction"
    | "pbr.transmission.useThicknessAsDepth"
    | "pbr.transmission.dispersion"
    | "pbr.mode.unlit"
    | "pbr.mode.unlitColor"
    | "pbr.mode.gammaAlbedo"
    | "pbr.mode.skybox"
    | "pbr.mode.shadowOnly"
    | "pbr.mode.shadowOnlyColor"
    | "pbr.mode.shadowOnlyOpacity"
    | "pbr.mode.shadowOnlyFalloff"
    | "pbr.stencil.compare"
    | "pbr.stencil.passOp"
    | "pbr.stencil.failOp"
    | "pbr.stencil.depthFailOp"
    | "pbr.stencil.readMask"
    | "pbr.stencil.writeMask"
    | "shader.configuration"
    | `shader.uniform:${string}`
    | `node.input:${string}`;

export interface MaterialInspectionProperty {
    readonly id: MaterialInspectionPropertyId;
    readonly section: MaterialInspectionSection;
    readonly label: string;
    readonly valueType: "string" | "boolean" | "number" | "vec2" | "vec3" | "vec4" | "mat4" | "enum" | "summary";
    readonly value: InspectionValue<MaterialInspectionPropertyValue>;
    readonly access: MaterialInspectionAccess;
    readonly options?: readonly { readonly value: string | number; readonly label: string }[];
}
```

The implementation builds the dynamic Shader/Node IDs from declaration/input names, rejects ambiguous duplicate IDs at material construction as today, and returns them in declaration order for Shader and lexicographic input-key order for Node. Matrix values are copied to a readonly sixteen-number tuple; no live typed array is exposed by the snapshot.

### 4.3 Named material texture bindings

```ts
export type TextureInspectionKind = "2d" | "2d-array" | "3d" | "cube" | "unknown";
export type TextureBindingKind = Exclude<TextureInspectionKind, "unknown">;
export type TextureSampleCategory = "float" | "unfilterable-float" | "depth" | "sint" | "uint" | "unknown";
export type TextureViewCategory = "2d" | "2d-array" | "3d" | "cube";
export type TextureBindingDirection = "assign" | "replace" | "clear" | "navigate";

export type MaterialTextureBindingId =
    | "standard.diffuse"
    | "standard.emissive"
    | "standard.bump"
    | "standard.specular"
    | "standard.ambient"
    | "standard.lightmap"
    | "standard.opacity"
    | "standard.reflection2d"
    | "standard.reflectionCube"
    | "pbr.baseColor"
    | "pbr.normal"
    | "pbr.orm"
    | "pbr.occlusion"
    | "pbr.emissive"
    | "pbr.specGloss"
    | "pbr.lightmap"
    | "pbr.metallicReflectance"
    | "pbr.reflectance"
    | "pbr.clearCoat"
    | "pbr.clearCoatRoughness"
    | "pbr.clearCoatBump"
    | "pbr.sheen"
    | "pbr.sheenRoughness"
    | "pbr.iridescence"
    | "pbr.iridescenceThickness"
    | "pbr.anisotropy"
    | "pbr.translucencyColor"
    | "pbr.translucencyIntensity"
    | "pbr.thickness"
    | "pbr.transmission"
    | `shader.sampler:${string}`
    | `node.texture:${string}`;

export interface MaterialInspectionTextureReference {
    /** The original Lite wrapper, intentionally typed as opaque object identity. */
    readonly entity: object;
    readonly kind: TextureBindingKind;
}

export interface MaterialTextureBinding {
    readonly id: MaterialTextureBindingId;
    readonly label: string;
    readonly value: InspectionValue<MaterialInspectionTextureReference>;
    readonly acceptedKinds: readonly TextureBindingKind[];
    readonly sampleCategory: TextureSampleCategory;
    readonly viewCategory: TextureViewCategory;
    readonly directions: readonly TextureBindingDirection[];
    readonly mutation: MaterialInspectionAccess;
    /** Present only when this binding's selected 2D wrapper exposes standard Lite UV transforms. */
    readonly transform: InspectionValue<TextureInspectionTransform>;
}

export interface MaterialInspection {
    /** Original source object; a selected MaterialView is unwrapped before this is returned. */
    readonly source: Material;
    readonly family: string | undefined;
    readonly displayName: string;
    readonly isView: boolean;
    readonly properties: readonly MaterialInspectionProperty[];
    readonly textureBindings: readonly MaterialTextureBinding[];
}

export function inspectMaterial(material: Material): MaterialInspection;
export function getMaterialTextureBindings(material: Material): readonly MaterialTextureBinding[];
```

`value.entity` is the original Lite wrapper used only for identity, assignment, and navigation. It is typed as opaque `object`, so no raw member is reachable from the new contract. The reference record is not used as selection identity: the adapter always passes `entity` itself to the existing selection service.

`getMaterialTextureBindings()` unwraps views and emits one descriptor for every supported semantic slot, including absent slots. It has fixed order:

- Standard: diffuse, emissive, bump, specular, ambient, lightmap, opacity, 2D reflection, cube reflection.
- PBR: base color, normal, ORM, separate occlusion, emissive, specular-glossiness, lightmap, metallic reflectance, reflectance, clear-coat intensity, clear-coat roughness, clear-coat bump, sheen color, sheen roughness, iridescence intensity, iridescence thickness, anisotropy, translucency color, translucency intensity, thickness, transmission.
- Shader: `samplerDecls` declaration order.
- Node: lexicographic public input key order.

It never depends on extension-registry insertion order. `getMaterialTextures()` becomes a projection of this result: retain only `present` values that satisfy the package's supported `Texture2D` classification, preserve binding order and duplicates across semantic slots, and omit every `CubeTexture`. This keeps the existing type and non-null behavior while eliminating a second source of slot ordering/inclusion truth.

Directional rules are part of each descriptor:

- `navigate` appears only for a present value.
- `assign` appears only for an absent slot whose current public setter/handle accepts a compatible value.
- `replace` appears only for a present, replaceable slot.
- `clear` appears only when the existing public setter/handle accepts `null` or the family setter can safely preserve the rest of an enabled feature while omitting that nested texture.
- Standard cube reflection reports `assign`, `replace`, and `clear` exactly as supported by `setStandardReflectionCubeTexture`, plus `navigate` when populated. The selected cube's Properties page remains metadata-only.
- PBR lightmap and metallic-reflectance setters do not expose a safe clear operation, so those bindings never report `clear`.
- No new unset API is introduced. Other currently unsupported directions are simply absent.

The complete direction/type matrix is:

| Binding group                                                                               | Accepted kind/view/sample         | Empty                                                            | Present                        |
| ------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| Standard 2D slots                                                                           | `2d`, `2d` view, float sample     | `assign`                                                         | `replace`, `clear`, `navigate` |
| Standard cube reflection                                                                    | `cube`, cube view, float sample   | `assign`                                                         | `replace`, `clear`, `navigate` |
| PBR six core slots                                                                          | `2d`, `2d` view, float sample     | `assign`                                                         | `replace`, `clear`, `navigate` |
| PBR lightmap                                                                                | `2d`, `2d` view, float sample     | `assign`                                                         | `replace`, `navigate`          |
| PBR metallic-reflectance / reflectance                                                      | `2d`, `2d` view, float sample     | `assign`                                                         | `replace`, `navigate`          |
| PBR clear-coat, sheen, iridescence, anisotropy, translucency, thickness, transmission slots | `2d`, `2d` view, float sample     | `assign` when the enclosing public setter can enable the feature | `replace`, `clear`, `navigate` |
| Shader sampler                                                                              | Declared view and sample category | `assign`                                                         | `replace`, `clear`, `navigate` |
| Node texture input                                                                          | `2d`, `2d` view, float sample     | `assign`                                                         | `replace`, `clear`, `navigate` |

“Float” includes a texture accepted by the existing public setter for that slot; depth/non-depth compatibility remains authoritative in `setShaderTexture`. No current binding accepts `3d`, so a discovered `Texture3D` cannot appear as a candidate until a public material slot supports it.

### 4.4 Texture metadata

```ts
export type TextureInspectionOrigin =
    "url-raster" | "ktx" | "basis" | "ktx2" | "solid" | "pixels" | "external-image" | "dynamic" | "html" | "render-target" | "sampled-depth" | "unknown";

export type TextureColorSpace = "linear" | "srgb" | "unknown";
export type TextureAddressMode = "clamp-to-edge" | "repeat" | "mirror-repeat";
export type TextureFilterMode = "nearest" | "linear";

export interface TextureInspectionTransform {
    readonly uScale: number;
    readonly vScale: number;
    readonly uOffset: number;
    readonly vOffset: number;
    readonly uAng: number;
}

export interface TextureSamplerInspection {
    readonly addressModeU: InspectionDatum<TextureAddressMode>;
    readonly addressModeV: InspectionDatum<TextureAddressMode>;
    readonly addressModeW: InspectionDatum<TextureAddressMode>;
    readonly minFilter: InspectionDatum<TextureFilterMode>;
    readonly magFilter: InspectionDatum<TextureFilterMode>;
    readonly mipmapFilter: InspectionDatum<TextureFilterMode>;
    readonly maxAnisotropy: InspectionDatum<number>;
}

export interface TextureInspection {
    readonly kind: TextureInspectionKind;
    readonly displayName: InspectionDatum<string>;
    readonly origin: InspectionDatum<TextureInspectionOrigin>;
    readonly width: number;
    readonly height: number;
    readonly depthOrLayers: InspectionDatum<number>;
    readonly sampleCategory: TextureSampleCategory;
    readonly format: InspectionDatum<string>;
    readonly mipLevelCount: InspectionDatum<number>;
    readonly colorSpace: TextureColorSpace;
    readonly invertY: InspectionValue<boolean>;
    readonly sampler: TextureSamplerInspection;
    readonly transform: InspectionValue<TextureInspectionTransform>;
    readonly capabilities: {
        readonly dynamicUpdate: InspectionDatum<boolean>;
        readonly htmlReadiness: InspectionDatum<"pending" | "ready" | "failed" | "disposed">;
        readonly renderAttachment: InspectionDatum<boolean>;
        readonly sampledDepth: boolean;
        readonly released: InspectionDatum<boolean>;
    };
}

/** Returns undefined for a value that is not a supported Lite texture wrapper. */
export function inspectTexture(texture: unknown): TextureInspection | undefined;
```

`inspectTexture()` is the public discriminator; Inspector does not independently test object shape. Its implementation is a package-private translation boundary and may read the package's own internal fields/raw handles. It immediately converts them to the safe vocabulary above and never returns them.

Origin is conservative. Existing retained provenance, HTML state, array/depth fields, sample type, or a known facade relationship may prove a more specific value. Otherwise it returns `{ state: "known", value: "unknown" }` and the least-specific valid kind. In particular, a `DynamicTexture2D` created while no existing runtime provenance is retained may be shown as `2D Texture` with only capabilities provable from its allocation; P4 does not add a permanent tag, registry write, or constructor hook merely for Inspector. This follows the explicit requirement not to guess allocation origin and is what reconciles precise reporting with zero non-Inspector bytes.

Sampler objects are opaque in WebGPU and current Lite textures do not retain all sampler descriptors. Therefore sampler fields are `unknown` unless existing retained source options prove them. P4 does not add always-on descriptor retention. Format, color space, mip count, sample category, dimensions, and render-attachment capability may be normalized internally from existing resources, but the public output is only strings/numbers/Lite enums.

For `CubeTexture`, the implementation reports kind, width, height, six layers, format, sample category, mip availability, color space, and safely known sampler facts. It reports `invertY` and transform as unsupported, all mutation capabilities as unavailable, and exposes no preview/editor action.

### 4.5 Mutation API

```ts
export interface MaterialInspectionMutationScope {
    /** Every live scene in the inspected engine that currently references the source material. */
    readonly scenes: readonly SceneContext[];
}

export type MaterialTextureMutation = { readonly direction: "assign" | "replace"; readonly texture: object } | { readonly direction: "clear" };

export interface MaterialInspectionMutationResult {
    readonly changed: boolean;
    readonly mutation: AppliedMaterialMutationClass;
    readonly postMutation: MaterialPostMutation;
}

export function setMaterialInspectionProperty(
    scope: MaterialInspectionMutationScope,
    material: Material,
    property: MaterialInspectionPropertyId,
    value: MaterialInspectionPropertyValue
): Promise<MaterialInspectionMutationResult>;

export function setMaterialInspectionTexture(
    scope: MaterialInspectionMutationScope,
    material: Material,
    binding: MaterialTextureBindingId,
    mutation: MaterialTextureMutation
): Promise<MaterialInspectionMutationResult>;

export function setTextureInspectionTransform(
    scope: MaterialInspectionMutationScope,
    texture: object,
    transform: TextureInspectionTransform
): Promise<MaterialInspectionMutationResult>;
```

The three functions:

1. resolve `MaterialView` to its source;
2. re-inspect immediately and reject a stale ID, incompatible value/kind, absent capability, unsupported direction, non-finite number, wrong tuple length, or out-of-range number before mutation;
3. compare normalized values and return `changed: false` without dirtying or rebuilding for an idempotent commit;
4. call the family setter/handle where one exists;
5. perform the descriptor's U/R/A invalidation;
6. resolve only after all requested rebuild work settles, or reject with the source value left in a valid inspectable state.

For a descriptor marked `U/R`, the family module computes the material's rendering-feature signature before the candidate write and for the candidate state using the same pure predicates as renderable construction. Equal signatures select U; any added/removed feature, binding shape, UV plumbing, blend class, or frame-graph participation selects R. If equivalence cannot be proved, R is the conservative result. The returned `MaterialInspectionMutationResult` always contains the applied class (`U`, `R`, or `A`), never `U/R`.

To make step 6 observable without changing existing callers, `rebuildMaterial` receives one additive overload:

```ts
export interface AwaitedRebuildMaterialOptions extends RebuildMaterialOptions {
    readonly awaitCompletion: true;
}

export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options: AwaitedRebuildMaterialOptions): Promise<void>;
// Existing overload and behavior remain:
export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): void;
```

The awaited overload executes the same rebuild algorithm, resolves after pending mesh builds and an optional frame-graph build, and rejects rather than logging. The existing overload retains its current fire-and-report behavior. The inspection mutation helper always uses `{ awaitCompletion: true, rebuildViews: true }`. It sets `rebuildFrameGraph: true` only when a transmission edit changes scene-color/frame-graph participation; other R edits use `false`.

No mutation helper retains scenes. Passing an empty scene list is valid only for A/U edits that do not request a scene rebuild; an R edit rejects before changing state. Inspector derives the complete owning-scene list from its resource index and passes it explicitly.

## 5. Material-Family Mapping

### 5.1 Common and unknown families

- All recognized families show `name` (editable) and `family` (read-only).
- Name is an A-class metadata write with no renderer invalidation. Empty names are valid and immediately switch the Explorer to its family fallback.
- A future/unknown family remains selectable. It shows only common identity and no speculative controls or bindings.
- `metadata`, `_renderFeatures`, `_uboVersion`, generated source, buffers, plugins, and internal state are never represented.

### 5.2 Standard

| Section           | Properties/bindings                                            | Access and exact path                                                     |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| General           | `backFaceCulling`, `disableLighting`                           | R: public fields, then awaited rebuild of all owning scenes/views         |
| Transparency      | `alpha`                                                        | U while opaque/blended classification is unchanged; R when crossing it    |
| Transparency      | `alphaCutOff`                                                  | U, finite validation                                                      |
| Lighting & Colors | four RGB colors                                                | U: copy tuple, assign source, call `markMaterialUboDirty` once            |
| Lighting & Colors | `specularPower`                                                | U, finite and minimum 0                                                   |
| Texture Settings  | four coordinate indices                                        | R, enum `0/UV1` or `1/UV2`                                                |
| Texture Settings  | five levels and `reflectionCoordMode`                          | U; finite, with reflection mode restricted to `1/spherical` or `2/planar` |
| Texture Settings  | `useLightmapAsShadowmap`, `opacityFromRGB`                     | R                                                                         |
| Transform         | material `uvScale`, `uvOffset`; enabled per-texture transforms | R for every Standard consumer                                             |
| Stencil           | public `StencilState`                                          | R after existing `enableMaterialStencil()` capability succeeds            |

Texture bindings use `diffuseTexture` directly only where no dedicated setter exists; optional slots use `setStandardEmissiveTexture`, `setStandardBumpTexture`, `setStandardSpecularTexture`, `setStandardAmbientTexture`, `setStandardLightmapTexture`, `setStandardOpacityTexture`, and `setStandardReflectionTexture`. Each 2D binding reports only directions its current API safely supports. The cube binding accepts only `CubeTexture`, uses `setStandardReflectionCubeTexture`, and exposes assignment/replacement/clear plus exact-object navigation; the selected cube's own page is metadata-only.

### 5.3 PBR

| Section                   | Properties/bindings                                                                                  | Access and exact path                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General                   | `doubleSided`, `alphaBlend`, `enableSpecularAA`                                                      | R                                                                                                                                                               |
| Transparency              | `alpha`                                                                                              | U if the blend feature result is unchanged; otherwise R; range 0–1                                                                                              |
| Transparency              | alpha cutoff                                                                                         | `setPbrAlphaCutoff`; U while alpha-test presence is unchanged, otherwise R                                                                                      |
| Lighting & Colors         | `baseColorFactor`                                                                                    | U while optional-factor presence is unchanged, otherwise R; linear RGBA                                                                                         |
| Lighting & Colors         | emissive color                                                                                       | `setPbrEmissive`; U/R on emissive-feature presence                                                                                                              |
| Lighting & Colors         | environment/direct intensity, reflectance, metallic/roughness factor, normal scale, physical falloff | U                                                                                                                                                               |
| Textures                  | six core slots                                                                                       | R; write the public slot because no texture-specific family setter exists, then rebuild                                                                         |
| Occlusion                 | strength                                                                                             | U except R when crossing the enabled boundary; range 0–1                                                                                                        |
| Occlusion                 | `occlusionTexCoord`                                                                                  | Read-only until a public setter owns the UV2 claim                                                                                                              |
| Lightmap                  | texture, level, UV set, shadowmap, gamma                                                             | Await `enablePbrLightmap()`, call `setPbrLightmap`, then R; assignment/replacement only, never clear                                                            |
| Metallic Reflectance      | all factors and two slots                                                                            | Reconstruct the full current option object, change one member, call `setPbrMetallicReflectance`, then U/R as reported; unsupported texture clear remains absent |
| Clear Coat                | all listed scalar/boolean fields and three slots                                                     | Reconstruct the complete public `ClearCoatProps` value represented by inspection, call `setPbrClearCoat`, then U/R                                              |
| Sheen                     | all listed values and two slots                                                                      | Reconstruct and call `setPbrSheen`, then U/R                                                                                                                    |
| Iridescence               | all listed values and two slots                                                                      | Reconstruct and call `setPbrIridescence`, then U/R                                                                                                              |
| Anisotropy                | enabled, intensity, direction, texture                                                               | Reconstruct and call `setPbrAnisotropy`, then U/R                                                                                                               |
| Subsurface / Translucency | intensity, color, diffusion distance, two slots                                                      | Reconstruct the whole `SubSurfaceProps`, call `setPbrSubsurface`, then U/R                                                                                      |
| Subsurface / Thickness    | min/max, glTF channel, texture                                                                       | Same `setPbrSubsurface` path                                                                                                                                    |
| Subsurface / Tint         | color and distance                                                                                   | Same `setPbrSubsurface` path                                                                                                                                    |
| Transmission              | intensity, IOR, thickness-depth mode, texture                                                        | Reconstruct and call `setPbrTransmission`; U/R, with frame-graph rebuild when participation changes                                                             |
| Transmission              | dispersion                                                                                           | `setPbrDispersion`; U/R, with frame-graph rebuild when participation changes                                                                                    |
| Special Modes             | unlit/tint, gamma albedo, skybox, shadow-only/color/opacity/falloff                                  | Present values only, read-only; no calls to one-way setters                                                                                                     |
| Transform                 | enabled per-texture transform                                                                        | Call `enableMaterialUvTransform`; U for already-enabled PBR consumers, R when support is enabled after compilation                                              |
| Stencil                   | public `StencilState`                                                                                | R after existing `enableMaterialStencil()` capability succeeds                                                                                                  |

The reserved non-rendering scattering object is omitted. Local-environment probe internals and scene IBL resources are omitted because they are not material bindings from this contract.

Within an already-compiled optional PBR feature, scalar/color/vector changes whose feature signature is unchanged are U. Enabling/disabling a layer, changing a texture's presence, changing a UV-set or shader-mode flag, or adding/removing an optional UBO/binding is R. Specifically: lightmap texture/UV/shadowmap/gamma, reflectance textures/metallic-only mode, clear-coat textures/F0 mode, sheen textures/albedo scaling, iridescence textures, anisotropy texture, subsurface texture/presence/channel modes, and transmission texture/presence are R; their in-place numeric/color values are U when their feature remains present. Dispersion is R when its shader path appears/disappears and U otherwise. Unknown transitions conservatively use R.

### 5.4 Shader

- General: editable `name`, read-only `shader` family.
- Inputs: enumerate declared non-system uniforms in declaration order. `f32`, `u32`, `i32`, vec2/3/4, and mat4 use matching finite controls. Every commit uses `setShaderUniform`; the helper never edits `_uniformValues`, `_uniformVersion`, or `_uboVersion`.
- Textures: enumerate every sampler declaration with its declared name, normalized sample category, normalized view dimension, and current/empty value. Compatibility is checked before `setShaderTexture`; a thrown setter leaves the old selection rendered.
- Configuration: attributes, defines, blend mode/state summary, transmissive, alpha testing, culling, depth write/compare, depth-only fragment, depth/slope bias, and topology are read-only.
- System uniforms are omitted. Storage-buffer values are omitted; declaration names may appear only in the read-only configuration summary. WGSL and defines are not editable.

P4 does not broaden Shader sampler dimensions. A `Texture2DArray` is navigable/assignable from a declared `2d-array` slot. `Texture3D` metadata is supported by the public texture contract and appears if a current or future public binding exposes it; P4 does not add an inert 3D sampler mode solely for Inspector.

### 5.5 Node

- General: editable `name`, read-only `node` family.
- Inputs: sort public `inputs` keys lexicographically. Display the key and declared handle type.
- `f32`, `vec2f`, `vec3f`, and `vec4f` values use scalar/vector/color-compatible controlled inputs and write only through `NodeInputHandle.value` (A).
- `texture2d` uses the public `NodeInputHandle.texture` accessor, followed by R for every owning scene/view.
- Graph structure, unnamed constants, generated WGSL, unexposed grouping/visibility state, and editor launch are omitted.

## 6. Texture UI and Consumer Semantics

The metadata-only texture page has these rows, conditioned entirely on `TextureInspection`:

| Group        | Rows                                                                               | P4 editability                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Identity     | display name/fallback, kind, origin                                                | Read-only                                                                                                                |
| Size         | width, height, depth/layer count                                                   | Read-only                                                                                                                |
| Sampling     | sample category, format, mip count/availability, color space, known sampler fields | Read-only                                                                                                                |
| Orientation  | `invertY`                                                                          | Read-only                                                                                                                |
| Capabilities | dynamic update, HTML readiness, render attachment, sampled depth, released state   | Read-only                                                                                                                |
| Transform    | scale U/V, offset U/V, angle                                                       | Editable only when the selected scene index reports at least one consumer that applies Lite standard transform semantics |
| Consumers    | every material display name and semantic slot                                      | Read-only links back to the exact source material                                                                        |

Transform commits modify only the selected wrapper. A clone and its base remain different entities even when their raw backing is shared. The adapter asks the resource index for all current-scene binding edges whose value is that exact wrapper, deduplicates source materials by object identity, and passes those scenes/sources through `setTextureInspectionTransform`. It never compares GPU resources. Standard consumers rebuild. PBR consumers use U after transform support already exists and R when `enableMaterialUvTransform` changes compiled support. Consumers that do not apply these semantics do not enable the controls.

Zero-sized/transient render targets render their reported current dimensions and a “Transient or unavailable” fallback rather than throwing. A sampled-depth facade shows depth sample capability. An HTML texture reports readiness without returning its element/host. Dynamic/HTML update actions are absent.

## 7. Inspector v2 Runtime-Neutral Boundary

### 7.1 Shared contracts

The shared-ui package adds presentation-only types with no Babylon.js or Lite imports:

```ts
export interface PropertyFieldModel {
    readonly key: string;
    readonly label: string;
    readonly section: string;
    readonly kind: "text" | "boolean" | "number" | "vector2" | "vector3" | "color3" | "color4" | "matrix4" | "enum" | "summary";
    readonly state: "unsupported" | "absent" | "present";
    readonly value?: string | number | boolean | readonly number[];
    readonly readOnly: boolean;
    readonly disabled: boolean;
    readonly constraints?: { readonly finite?: boolean; readonly integer?: boolean; readonly min?: number; readonly max?: number };
}

export interface TextureChoiceModel {
    readonly key: string;
    readonly name: string;
    readonly entity: object;
    readonly kind: string;
    readonly sampleCategory: string;
    readonly viewCategory: string;
}

export interface TextureBindingModel {
    readonly key: string;
    readonly label: string;
    readonly state: "unsupported" | "empty" | "present";
    readonly current?: TextureChoiceModel;
    readonly choices: readonly TextureChoiceModel[];
    readonly canAssign: boolean;
    readonly canReplace: boolean;
    readonly canClear: boolean;
    readonly canNavigate: boolean;
}

export interface MaterialPropertyAdapter {
    getFields(): readonly PropertyFieldModel[];
    getTextureBindings(): readonly TextureBindingModel[];
    commitField(key: string, value: unknown, signal: AbortSignal): Promise<void>;
    commitTexture(key: string, direction: "assign" | "replace" | "clear", entity: object | undefined, signal: AbortSignal): Promise<void>;
    navigate(entity: object): void;
}

export interface TextureMetadataAdapter {
    getFields(): readonly PropertyFieldModel[];
    getConsumers(): readonly { readonly key: string; readonly label: string; readonly material: object }[];
    commitTransform(value: readonly [number, number, number, number, number], signal: AbortSignal): Promise<void>;
    navigate(entity: object): void;
}
```

`MaterialPropertySectionCore`, `TextureBindingPropertyLineCore`, and `TextureMetadataPropertiesCore` consume only these contracts. They follow the existing `ControlledTensorPropertyLine`/`TensorValueAdapter` and `ControlledColorPropertyLine`/`ColorPropertyLineAdapter` pattern: arrays are copied into controlled values; Babylon.js adapters may wrap mutable vector/color classes; Lite adapters preserve tuples directly.

The existing Babylon.js material and texture service behavior is adapted incrementally to these cores. The cores never import `Scene`, `Material`, `BaseTexture`, `Texture`, `CubeTexture`, or `@babylonjs/lite`. The Babylon.js adapter never imports Lite, and the Lite adapter never imports Babylon.js material/texture classes.

### 7.2 Explicit non-boundary

`texturePreview.tsx`, `textureEditor/*`, `textureEditorService.tsx`, texture-debug materials, channel/face/layer/slice/LOD readback, upload, save, reset, resize, and export remain untouched. No preview/editor interface is added to the shared adapter types. The Lite service renders no action, disabled button, placeholder, or dynamic import for those capabilities.

## 8. Discovery, Identity, Naming, and Refresh

### 8.1 `LiteSceneResourceIndex`

The Lite Inspector entry constructs one `LiteSceneResourceIndex` per inspected engine. Its maps are instance fields allocated by the factory, never module state:

```ts
interface SceneResourceSnapshot {
    readonly scene: SceneContext;
    readonly materials: readonly MaterialResourceRecord[];
    readonly textures: readonly TextureResourceRecord[];
}

interface MaterialResourceRecord {
    readonly source: Material;
    readonly scenes: readonly SceneContext[];
    readonly bindings: readonly MaterialTextureBinding[];
}

interface TextureResourceRecord {
    readonly entity: object;
    readonly inspection: TextureInspection;
    readonly ordinal: number;
    readonly consumers: readonly { readonly material: Material; readonly bindingId: MaterialTextureBindingId }[];
}
```

Discovery is deterministic:

1. Walk `scene.meshes` in array order and ignore null materials.
2. Resolve each material/view with the public source helper used by `inspectMaterial`.
3. Keep the first source occurrence by object identity.
4. Inspect each source's bindings in canonical order.
5. For every present binding, append a consumer edge. Deduplicate the texture row by wrapper object identity only.
6. Assign a per-index monotonic ordinal the first time an object appears. Keep it while the object remains anywhere in the engine snapshot; delete its strong record when unreachable so the `WeakMap` key can collect.
7. Include a cube exactly like another texture entity for identity/navigation, while its metadata determines the page.

Material fallback names are `<Capitalized family> Material`; unknown/empty family is `Material`. Texture fallback names are `<Kind> Texture <ordinal> (<width> × <height>[ × <depth/layers>])`, using `2D`, `2D Array`, `3D`, or `Cube`. A future explicit public texture name wins. Multiplication uses `×`.

### 8.2 Explorer and selection

`sceneResources.ts` becomes the sole data source for material/texture Explorer providers. Material nodes use source objects, not views. Texture nodes use original wrappers, not DTOs. Existing `GetEntityId`/Explorer object identity and `ISelectionService` therefore preserve selection/history naturally.

Links are buttons/anchors using the existing selection service. A material binding link selects its exact texture; a texture consumer link selects the exact source material. Empty bindings have no focusable link. If an entity disappears from one scene but remains in another, its global identity remains. If it is absent from the selected scene, the existing selection convention is applied: clear selection rather than leave scene-dependent edits active. A detached object may be displayed read-only only if the selection service already chooses to retain it.

### 8.3 Watch snapshots

The Explorer topology watcher uses an ordered primitive/reference snapshot:

```text
scene reference
  material source reference
    family + display name
    binding id + state + exact texture wrapper reference
      texture kind + dimensions + capability/readiness primitives
```

Equality uses `Object.is` per element and ordered array comparison. It does not stringify, compare GPU handles, or allocate wrapper identities. It detects null/material swaps, source/view changes, new/removed/shared bindings, facade dimension changes, and capability transitions.

Each open Properties component obtains a fresh inspection snapshot through `watchValue`. Manual mode calls the same getter synchronously on `refresh()`. Polling mode uses the configured watcher interval. Successful mutations request one watcher refresh so changes are visible by the next Inspector refresh and render frame. External edits are picked up without reselection.

### 8.4 Async generations and disposal

Each adapter instance owns `{ generation, abortController, disposed }`.

- Increment generation and abort the previous controller before each commit.
- Capture selected entity, property/binding ID, and generation.
- On completion, update pending/error state only if all three still match and the adapter is live.
- A late successful mutation may have affected the runtime, but it cannot overwrite another selection's UI; the next snapshot remains authoritative.
- Dispose aborts in-flight UI work, unsubscribes watchers, disposes resource-index subscriptions, and prevents state updates.
- `useAsyncResource` remains the component lifecycle primitive; expected rejections are caught by the adapter and represented locally instead of being silently discarded by the hook.

## 9. Mutation Transactions and Failure Behavior

```text
user commit
   |
   +-> shared control validates shape/basic finite input
   |
Lite adapter snapshots source + generation
   |
   +-> Lite mutation helper revalidates capability, direction, range, kind
   |
   +-> apply exactly one source write/setter/handle
   |
   +-> U: markMaterialUboDirty(source) exactly once
   |   R: rebuildMaterial(scene, source, awaited) once per owning scene
   |   A: public API owns counters; optional declared post-rebuild only
   |
success -> clear pending/error -> watcher.refresh()
failure -> discard draft -> re-inspect source -> accessible error state
```

Rules:

- Arrays/tuples are copied. No draft mutates live state before commit.
- An unsupported direction or incompatible texture is rejected before a setter, UBO mark, or rebuild.
- A texture replacement changes one semantic slot only. It never disposes the old texture or edits another slot/consumer.
- U-class edits call `markMaterialUboDirty(source)` exactly once, after a changed write.
- R-class edits call the appropriate public setter first, then the awaited `rebuildMaterial` once for each unique owning scene. Default `rebuildViews: true` updates source views.
- A-class edits use only `setShaderUniform`, `setShaderTexture`, or `NodeInputHandle` accessors. Node texture handles additionally request the declared R post-step; Shader setters do not receive duplicate invalidation.
- Feature transitions choose U versus R from before/after inspection state, not merely from the row ID.
- Asynchronous enablement (`enablePbrLightmap`) occurs before committing state. Synchronous UV-transform/stencil enablement also precedes the value write. An enablement failure leaves the source untouched.
- Setter/validation failure restores the controlled draft from a fresh snapshot. A rebuild failure is shown against the actual re-inspected source value; no unsupported inverse API is invented to fake rollback. Other bindings and selection remain intact.
- The operation error contains the visible row label, failed operation, concise decoded Lite message when available, and a retry action when retry is safe. Expected validation/capability errors are not logged. An unexpected adapter error is logged at most once per operation and also displayed.

## 10. Accessibility

- Shared cores use existing Inspector v2 `Field`, property-line, switch, numeric, vector, color, accordion, and focus styles.
- Every visible label is the accessible name for its value/control.
- Texture links use `"<slot label>: open <destination name>"`; consumer links use `"Open material <name>, <slot label>"`.
- Empty, unavailable, and read-only rows are not presented as clickable controls.
- Selectors support pointer and keyboard selection, expose `aria-disabled`, and include only compatible candidates plus “None” when `clear` is supported.
- Pending writes disable only the initiating control and set `aria-busy`.
- Validation/adapter failures render beside the control in a polite `role="status"` for validation or `role="alert"` for failed operations; focus stays on or returns to the initiating control. Dismiss is keyboard operable.
- Existing `ErrorBoundary` remains the last-resort render boundary. It is not used as the expected validation path.

## 11. Dependency and Loading Architecture

```text
@babylonjs/lite/index.ts
  -> inspection/material-inspection.ts
       -> family inspection modules
       -> existing public setters / dirty / rebuild
  -> inspection/texture-inspection.ts
       -> package-private metadata readers

@babylonjs/inspector/lite (dynamic application opt-in)
  -> lite scene resource index
  -> Lite material adapter --dynamic per selected family--> Lite family component
  -> Lite texture adapter --dynamic on selected texture--> metadata-only component
  -> shared runtime-neutral cores

@babylonjs/inspector (Babylon.js entry)
  -> Babylon.js adapters
  -> shared runtime-neutral cores
  -> existing Babylon.js preview/editor (unchanged)
```

There is no edge from the Babylon.js entry to `@babylonjs/lite`, no edge from the Lite entry to Babylon.js material/texture implementations, and no edge from a P4 shared core to either runtime. Type-only imports must compile away.

Family-specific Inspector implementations are dynamically imported from the Lite material property service after `getMaterialFamily()` resolves the selected source. Texture metadata code is dynamically imported only for a selected discovered texture. Neither lazy branch imports preview/editor modules.

All Lite inspection files are side-effect-free. Read-only family descriptor modules do not import feature fragments or call extension registries. A mutation dynamically imports an opt-in setter/enablement module only when that operation actually needs it; inspecting a disabled PBR/Standard feature therefore does not register or load the feature. Constant descriptor arrays may be module constants only when emitted as immutable literals and shown by the bundle test to disappear when unused; any cache is allocated inside an invoked function or Inspector service and is disposable. No registration call occurs at module evaluation.

## 12. File and Module Responsibilities

### 12.1 Babylon Lite repository

| File                                                                    | Responsibility                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/babylon-lite/src/inspection/inspection-types.ts`              | Public pure-data capability, value, property, binding, texture metadata, and mutation result types                         |
| `packages/babylon-lite/src/inspection/material-inspection.ts`           | Source unwrapping, family dispatch, stable display-name fallback, public getters/mutators, validation, U/R/A orchestration |
| `packages/babylon-lite/src/inspection/standard-material-inspection.ts`  | Complete Standard descriptor table and existing-setter routing                                                             |
| `packages/babylon-lite/src/inspection/pbr-material-inspection.ts`       | Complete PBR descriptor table, feature-boundary classification, option reconstruction, one-way read-only policy            |
| `packages/babylon-lite/src/inspection/shader-material-inspection.ts`    | Declared non-system uniform/sampler snapshots and setter routing                                                           |
| `packages/babylon-lite/src/inspection/node-material-inspection.ts`      | Deterministically ordered public input snapshots and handle routing                                                        |
| `packages/babylon-lite/src/inspection/texture-inspection.ts`            | Safe kind/origin/metadata normalization; no raw resource in return type                                                    |
| `packages/babylon-lite/src/material/material-textures.ts`               | Legacy projection over canonical named binding enumeration                                                                 |
| `packages/babylon-lite/src/material/material-rebuild.ts`                | Add awaited overload while preserving existing overload behavior                                                           |
| `packages/babylon-lite/src/index.ts`                                    | Root-only exports                                                                                                          |
| Focused `tests/lite/unit/*inspection*.test.ts`                          | Public contract, family matrix, texture metadata, mutation, views/shared consumers                                         |
| `tests/lite/build/public-api-types.test.ts` and focused bundle fixtures | Root export, declaration trimming/no raw GPU types, byte-isolation proof                                                   |

The exact split may combine family files only if per-family tree shaking and ownership stay demonstrably equivalent. It must not merge inspection/UI logic into hot render paths.

### 12.2 Babylon.js Inspector v2 repository

| File                                                                                              | Responsibility                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/materialPropertySectionCore.tsx`    | Runtime-neutral section and typed field rendering                                 |
| `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/textureBindingPropertyLineCore.tsx` | Runtime-neutral direction-aware selector and exact-object link                    |
| `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/textureMetadataPropertiesCore.tsx`  | Runtime-neutral metadata/transform/consumer rows only                             |
| `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneResources.ts`                       | `LiteSceneResourceIndex`, canonical discovery, consumers, ordinals, owning scenes |
| `packages/dev/inspector-v2/src/lite/services/panes/scene/materialExplorerService.tsx`             | Source-material rows/names and topology snapshots                                 |
| `packages/dev/inspector-v2/src/lite/services/panes/scene/textureExplorerService.tsx`              | Kind-aware rows/names and exact-object selection                                  |
| `packages/dev/inspector-v2/src/lite/services/panes/properties/materialPropertiesService.tsx`      | Common section and lazy family component selection                                |
| `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/*`                 | Lite snapshot-to-core adapters and async operation state per family               |
| `packages/dev/inspector-v2/src/lite/services/panes/properties/texturePropertiesService.tsx`       | Resource-index predicate and lazy metadata-only page                              |
| `packages/dev/inspector-v2/src/lite/services/panes/properties/liteTextureMetadataAdapter.ts`      | Safe metadata, consumer links, transform mutation                                 |
| `packages/dev/inspector-v2/src/components/properties/materials/*Adapter.tsx`                      | Babylon.js adapters to shared P4 cores; preserve native semantics                 |
| Focused `packages/dev/inspector-v2/test/unit/lite*` and adapter tests                             | Explorer, D/E/N, refresh, error, accessibility, disposal, package isolation       |

Existing `texturePreview.tsx`, `textureEditor/*`, `materialTextureDebugPropertyLine.tsx`, and Babylon.js-only services are explicitly not modified for P4.

## 13. Focused Verification Strategy

No all-scene, visual/parity, unfiltered parity, or unfiltered scene-bundle command is part of local validation.

### 13.1 Lite unit tests

1. **Contract/family:** Standard, PBR, Shader, Node, unknown family, malformed input, and `MaterialView` source unwrapping.
2. **Bindings:** every fixed slot in exact canonical order; absent entries retained; duplicate textures retained per slot; Standard cube included; legacy projection excludes null/cube and preserves projected order.
3. **Texture kinds:** ordinary/clone, dynamic when provable and conservative fallback otherwise, HTML readiness/disposal without DOM exposure, array layers, 3D depth, render attachment/depth, and cube metadata.
4. **Property matrix:** every required ID, value/default/absent state, access, range, U/R/A class, and omitted out-of-scope fields.
5. **Mutation:** chosen public setter/handle spies, one `markMaterialUboDirty` for changed U edits, no churn for same value, all owning-scene rebuilds including views, frame-graph rebuild for transmission participation, compatible selection, and unsupported directions producing zero writes.
6. **Failure:** invalid finite/range/tuple inputs, setter errors, enablement rejection, awaited rebuild rejection, source reinspection, and no collateral slot/disposal mutation.

### 13.2 Inspector v2 unit/component tests

1. Resource discovery ignores null, unwraps views, deduplicates by object identity, preserves first-reference/canonical order, lists all consumers, and keeps stable IDs/ordinals across rename, reorder, and sharing.
2. Each Standard/PBR matrix row renders with the expected Inspector section, label, control/read-only state, and capability.
3. Shader typed controls and sampler compatibility; Node deterministic inputs and rebuild-after-texture behavior.
4. Shared cores run against both Babylon.js and Lite fake adapters.
5. Pointer and keyboard navigation select the exact original entity and selection history returns normally.
6. Manual and polling updates cover names, scalar/vector/color state, bindings, transforms, dimensions, capabilities, topology, and feature-row appearance.
7. Pending-generation tests cover selection change, unmount, engine disposal, late resolve/reject, and stale error suppression.
8. Accessibility queries assert names, focus, disabled state, `aria-busy`, status/alert announcements, and error dismissal.
9. Static import tests prove no preview/editor/debug imports in P4 cores or Lite adapters and no cross-runtime entry imports.

### 13.3 Package and size tests

- Type tests import every new symbol only from `@babylonjs/lite`.
- Rolled declaration tests assert no raw WebGPU type is reachable from a new inspection result.
- Existing `getMaterialFamily`, guards, and `getMaterialTextures` tests remain green.
- Build two representative non-Inspector apps from identical entry points before/after the feature and compare emitted runtime chunk bytes and fetched chunk graph exactly; the delta must be zero.
- Add focused Inspector-enabled chunks to prove family and texture metadata components load on demand and do not retain preview/editor code.
- Run the existing focused Lite unit/typecheck/lint and Inspector v2 unit/typecheck commands for touched modules. CI owns visual/parity and repository-wide scene coverage; no golden or ceiling is changed.

### 13.4 Risks and mitigations

| Risk                                                                  | Mitigation                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU samplers do not reveal their creation descriptor               | Report individual fields as unknown; never infer from object identity or create probe samplers                                      |
| Some texture allocation origins are not retained                      | Use the least-specific valid kind/origin; do not add always-on constructor metadata solely for Inspector                            |
| A source material is shared by scenes or represented by views         | Resource index computes explicit owning scenes; mutation unwraps once and rebuilds with views in every scene                        |
| Optional PBR setters register lazy extensions                         | Invoke only from the selected family's mutation module, await required enablement first, and use signature-based U/R classification |
| Async rebuild completes after selection/disposal                      | Awaited overload plus adapter generation/abort guards; runtime state may complete, stale UI state may not                           |
| Canonical binding order drifts from legacy enumeration                | One canonical table feeds both inspection and `getMaterialTextures`; one ordering test covers both                                  |
| Shared UI accidentally retains a runtime or preview/editor dependency | Import-boundary tests and separate adapters/entry points                                                                            |
| Root exports accidentally increase ordinary application output        | Byte-for-byte non-Inspector build comparison; no ceiling adjustment is permitted                                                    |

## 14. Requirement Traceability

All requirements are architecturally satisfied. “Verified by” identifies the principal design/test section; implementation acceptance still requires the focused evidence above.

| Requirement   | Status    | Architecture / verification                                          |
| ------------- | --------- | -------------------------------------------------------------------- |
| REQ-SCOPE-1   | Satisfied | §§2, 7, 10; existing pane/section/watcher conventions                |
| REQ-SCOPE-2   | Satisfied | §§5–7; mapped Lite terminology and Inspector labels                  |
| REQ-SCOPE-3   | Satisfied | §§5.1–5.5; explicit omission lists                                   |
| REQ-SCOPE-4   | Satisfied | §§3, 4.5, 8; immutable snapshots and explicit scene scope            |
| REQ-SCOPE-5   | Satisfied | §4 and §12.1; root exports only                                      |
| REQ-SCOPE-6   | Satisfied | §§3–4, 7; normalized data and object identity, no raw handles        |
| REQ-API-1     | Satisfied | §§4.1–4.4; public typed discriminators replace Inspector duck typing |
| REQ-API-2     | Satisfied | §§4.2–4.3                                                            |
| REQ-API-3     | Satisfied | §4.3; canonical slots, cube, legacy projection                       |
| REQ-API-4     | Satisfied | §4.4 and §6                                                          |
| REQ-API-5     | Satisfied | §4.1 discriminated `InspectionValue`                                 |
| REQ-API-6     | Satisfied | §§4.3, 4.5, 8.1; source unwrapping, existing guards unchanged        |
| REQ-API-7     | Satisfied | §4.5 explicit `scenes` scope                                         |
| REQ-API-8     | Satisfied | §§4, 4.3; usable root APIs and fixed order                           |
| REQ-ADAPT-1   | Satisfied | §7.1 runtime-neutral contracts                                       |
| REQ-ADAPT-2   | Satisfied | §§2.2, 7.1                                                           |
| REQ-ADAPT-3   | Satisfied | §7.1 controlled tuple adapters                                       |
| REQ-ADAPT-4   | Satisfied | §7.1 `TextureBindingModel`/adapter                                   |
| REQ-ADAPT-5   | Satisfied | §§6–7.1 metadata adapter                                             |
| REQ-ADAPT-6   | Satisfied | §§1, 7.2                                                             |
| REQ-ADAPT-7   | Satisfied | §§1, 7.2                                                             |
| REQ-ADAPT-8   | Satisfied | §§6, 7.2                                                             |
| REQ-ADAPT-9   | Satisfied | §§8.4, 9–10                                                          |
| REQ-ADAPT-10  | Satisfied | §§7.1, 11                                                            |
| REQ-DISC-1    | Satisfied | §8.1 steps 1–3                                                       |
| REQ-DISC-2    | Satisfied | §8.1 steps 4–5                                                       |
| REQ-DISC-3    | Satisfied | §§8.1–8.2                                                            |
| REQ-DISC-4    | Satisfied | §8.1 naming                                                          |
| REQ-DISC-5    | Satisfied | §8.1 naming/ordinals                                                 |
| REQ-DISC-6    | Satisfied | §§7.1, 8.2, 10                                                       |
| REQ-DISC-7    | Satisfied | §§4.3, 8.2                                                           |
| REQ-DISC-8    | Satisfied | §8.2 exact entities/history                                          |
| REQ-DISC-9    | Satisfied | §5.1                                                                 |
| REQ-DISC-10   | Satisfied | §§5.1, 8.2, 9                                                        |
| REQ-MAT-1     | Satisfied | §5.1                                                                 |
| REQ-MAT-2     | Satisfied | §§4.1, 7.1, 9                                                        |
| REQ-MAT-3     | Satisfied | §§4.3, 7.1, 9                                                        |
| REQ-MAT-4     | Satisfied | §§4.5, 5.2–5.5                                                       |
| REQ-STD-1     | Satisfied | §§5.1–5.2                                                            |
| REQ-STD-2     | Satisfied | §5.2 General                                                         |
| REQ-STD-3     | Satisfied | §5.2 Transparency                                                    |
| REQ-STD-4     | Satisfied | §5.2 Transparency                                                    |
| REQ-STD-5     | Satisfied | §5.2 Lighting & Colors                                               |
| REQ-STD-6     | Satisfied | §5.2 Lighting & Colors                                               |
| REQ-STD-7     | Satisfied | §§4.3, 5.2 texture setters                                           |
| REQ-STD-8     | Satisfied | §§4.3, 5.2 cube navigation                                           |
| REQ-STD-9     | Satisfied | §5.2 Texture Settings                                                |
| REQ-STD-10    | Satisfied | §5.2 Texture Settings                                                |
| REQ-STD-11    | Satisfied | §5.2 Texture Settings                                                |
| REQ-STD-12    | Satisfied | §§5.2, 6                                                             |
| REQ-STD-13    | Satisfied | §5.2 Stencil                                                         |
| REQ-PBR-1     | Satisfied | §§5.1, 5.3                                                           |
| REQ-PBR-2     | Satisfied | §5.3 General                                                         |
| REQ-PBR-3     | Satisfied | §5.3 Transparency                                                    |
| REQ-PBR-4     | Satisfied | §5.3 Transparency                                                    |
| REQ-PBR-5     | Satisfied | §5.3 Lighting & Colors                                               |
| REQ-PBR-6     | Satisfied | §5.3 Lighting & Colors                                               |
| REQ-PBR-7     | Satisfied | §5.3 Lighting & Colors                                               |
| REQ-PBR-8     | Satisfied | §§4.3, 5.3 Textures                                                  |
| REQ-PBR-9     | Satisfied | §5.3 Occlusion                                                       |
| REQ-PBR-10    | Satisfied | §5.3 read-only UV claim                                              |
| REQ-PBR-11    | Satisfied | §§4.3, 5.3 Lightmap                                                  |
| REQ-PBR-12    | Satisfied | §5.3 Metallic Reflectance                                            |
| REQ-PBR-13    | Satisfied | §5.3 Clear Coat                                                      |
| REQ-PBR-14    | Satisfied | §5.3 Sheen                                                           |
| REQ-PBR-15    | Satisfied | §5.3 Iridescence                                                     |
| REQ-PBR-16    | Satisfied | §5.3 Anisotropy                                                      |
| REQ-PBR-17    | Satisfied | §5.3 Subsurface / Translucency                                       |
| REQ-PBR-18    | Satisfied | §5.3 Subsurface / Thickness                                          |
| REQ-PBR-19    | Satisfied | §5.3 Subsurface / Tint                                               |
| REQ-PBR-20    | Satisfied | §5.3 Transmission                                                    |
| REQ-PBR-21    | Satisfied | §5.3 Transmission                                                    |
| REQ-PBR-22    | Satisfied | §5.3 Special Modes, read-only                                        |
| REQ-PBR-23    | Satisfied | §§5.3, 6 Transform                                                   |
| REQ-PBR-24    | Satisfied | §5.3 Stencil                                                         |
| REQ-SHD-1     | Satisfied | §5.4 General                                                         |
| REQ-SHD-2     | Satisfied | §5.4 Inputs                                                          |
| REQ-SHD-3     | Satisfied | §§4.3, 5.4 Textures                                                  |
| REQ-SHD-4     | Satisfied | §5.4 Configuration                                                   |
| REQ-SHD-5     | Satisfied | §5.4 omissions                                                       |
| REQ-NODE-1    | Satisfied | §5.5 General                                                         |
| REQ-NODE-2    | Satisfied | §5.5 value handles                                                   |
| REQ-NODE-3    | Satisfied | §5.5 texture handles                                                 |
| REQ-NODE-4    | Satisfied | §5.5 deterministic keys                                              |
| REQ-TEX-1     | Satisfied | §§4.4, 6                                                             |
| REQ-TEX-2     | Satisfied | §§4.4, 6                                                             |
| REQ-TEX-3     | Satisfied | §6 consumer-aware transforms                                         |
| REQ-TEX-4     | Satisfied | §6 orientation read-only                                             |
| REQ-TEX-5     | Satisfied | §6 sampling metadata read-only                                       |
| REQ-TEX-6     | Satisfied | §§6, 8.1 object identity                                             |
| REQ-TEX-7     | Satisfied | §§6, 8.1 consumer edges                                              |
| REQ-TK-1      | Satisfied | §§4.4, 6 ordinary/provenance fallback                                |
| REQ-TK-2      | Satisfied | §§4.4, 6 dynamic capability                                          |
| REQ-TK-3      | Satisfied | §§4.4, 6 HTML readiness without DOM                                  |
| REQ-TK-4      | Satisfied | §§4.4, 6 facade/depth capabilities                                   |
| REQ-TK-5      | Satisfied | §§4.4, 5.4, 6 array metadata/navigation                              |
| REQ-TK-6      | Satisfied | §§4.4, 5.4, 6 3D metadata/future binding                             |
| REQ-TK-7      | Satisfied | §§4.3–4.4, 6 cube metadata/navigation only                           |
| REQ-MUT-1     | Satisfied | §§4.2, 4.5, 9                                                        |
| REQ-MUT-2     | Satisfied | §§4.5, 9 U path                                                      |
| REQ-MUT-3     | Satisfied | §§4.5, 9 R path                                                      |
| REQ-MUT-4     | Satisfied | §§5.4–5.5, 9 A path                                                  |
| REQ-MUT-5     | Satisfied | §§4.3, 5.3, 9                                                        |
| REQ-MUT-6     | Satisfied | §§6, 9                                                               |
| REQ-MUT-7     | Satisfied | §9                                                                   |
| REQ-MUT-8     | Satisfied | §§4.5, 8.1, 9                                                        |
| REQ-MUT-9     | Satisfied | §§8.3, 9                                                             |
| REQ-MUT-10    | Satisfied | §§8.4, 9–10                                                          |
| REQ-REFRESH-1 | Satisfied | §8.3                                                                 |
| REQ-REFRESH-2 | Satisfied | §§8.1–8.3                                                            |
| REQ-REFRESH-3 | Satisfied | §8.3                                                                 |
| REQ-REFRESH-4 | Satisfied | §8.2                                                                 |
| REQ-REFRESH-5 | Satisfied | §8.4                                                                 |
| REQ-REFRESH-6 | Satisfied | §8.4                                                                 |
| REQ-A11Y-1    | Satisfied | §10                                                                  |
| REQ-A11Y-2    | Satisfied | §10                                                                  |
| REQ-A11Y-3    | Satisfied | §10                                                                  |
| REQ-A11Y-4    | Satisfied | §§9–10                                                               |
| REQ-A11Y-5    | Satisfied | §§7.1, 10                                                            |
| REQ-ERR-1     | Satisfied | §§4.1, 4.4, 6, 9                                                     |
| REQ-ERR-2     | Satisfied | §§8.4, 9                                                             |
| REQ-ERR-3     | Satisfied | §9 prevalidation                                                     |
| REQ-SIZE-1    | Satisfied | §§3, 11, 13.3                                                        |
| REQ-SIZE-2    | Satisfied | §§3, 8.1, 11                                                         |
| REQ-SIZE-3    | Satisfied | §§7.2, 11                                                            |
| REQ-SIZE-4    | Satisfied | §§7.1, 11                                                            |
| REQ-SIZE-5    | Satisfied | §13.3                                                                |
| REQ-TEST-1    | Satisfied | §13.1                                                                |
| REQ-TEST-2    | Satisfied | §13.2                                                                |
| REQ-TEST-3    | Satisfied | §§13.1–13.2                                                          |
| REQ-TEST-4    | Satisfied | §13.2                                                                |
| REQ-TEST-5    | Satisfied | §13.2                                                                |
| REQ-TEST-6    | Satisfied | §§7.2, 13.2                                                          |
| REQ-TEST-7    | Satisfied | §§10, 13.2                                                           |
| REQ-TEST-8    | Satisfied | §13.3                                                                |
| REQ-TEST-9    | Satisfied | §13                                                                  |

## 15. Key Decisions

1. Use public, immutable snapshots and explicit standalone mutations rather than exposing internals or introducing classes.
2. Keep the semantic binding table canonical in Lite and derive legacy `getMaterialTextures()` from it.
3. Use original wrapper/source object identity for Explorer and selection; store IDs, ordinals, consumers, and scenes only in an Inspector-owned service instance.
4. Make asynchronous rebuild completion explicitly awaitable through an additive `rebuildMaterial` overload so failures can be tied to an operation.
5. Treat `U/R` as a before/after feature-boundary decision, not a static control property.
6. Keep unsupported directions absent. In particular, PBR lightmap/metallic-reflectance clear and reversible one-way PBR modes are not invented.
7. Include Standard `CubeTexture` in discovery and selection but keep its P4 page metadata-only.
8. Report unknown provenance/sampler details honestly instead of adding always-on metadata or guessing.
9. Reuse controlled vector/color and existing pane/selection/watcher conventions, but introduce a runtime-neutral binding adapter rather than reusing Babylon.js `BaseTexture` selectors.
10. Defer the entire preview/editor boundary and every Lite texture action to P11b.

## 16. Open Architecture Decisions

None. The approved decisions are fully represented:

- Standard cube reflection keeps its existing binding assignment/replacement/clear directions; navigation opens a metadata-only cube Properties page.
- Unsupported clear/unset directions remain unavailable; no APIs are added to manufacture them.
- One-way PBR modes are read-only.
- Preview/editor extraction and all Lite preview/editor actions are deferred to P11b.

Implementation may adjust private file granularity, but changing a public signature, U/R/A classification, directional capability, load boundary, or resolved decision requires architecture re-approval.
