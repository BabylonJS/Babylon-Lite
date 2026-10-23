# Module: glTF 2.0 Exporter

> Package path: `packages/babylon-lite/src/export-gltf/`
>
> Behavioral reference: the Babylon.js glTF serializer (`@babylonjs/serializers` v9.30.0, released 2026-10-08; `master` @ `676f462`, 2026-10-14) wherever the two engines share a concept. Babylon.js test names, playground ids and `config.json` entries cited below are pinned to that commit. Every divergence is recorded in the Babylon.js Equivalence Map.

## Quick start

After you have added the content to a scene, call `exportSceneAsGlb` to get a downloadable binary glTF file as a `Blob`:

```typescript
import { exportSceneAsGlb } from "@babylonjs/lite";

const glb = await exportSceneAsGlb(scene);
```

The exporter reads the scene without changing it. The returned Blob can be saved or uploaded by your application.

---

## Purpose

`exportSceneAsGlb` serializes a `SceneContext` into a single binary glTF 2.0 (`.glb`) `Blob`. The Blob holds one JSON chunk and one BIN chunk; images are embedded as bufferViews.

The exporter is the inverse of `loadGltf`. Round trips are a design goal. The exporter recognizes and removes the artifacts the loader inserts: the `__root__` conversion node, camera fixup nodes, and factor-baked 1×1 textures. As a result, `loadGltf → exportSceneAsGlb → loadGltf` reproduces the source structure, within the limits listed under Scope. For glTF-loaded content a second round trip is byte-identical to the first; natively built content settles one round trip later (see Test Specification).

The module handles four concerns:

1. **Handedness.** Lite scenes are left-handed. glTF is right-handed, with CCW front faces and −Z-forward cameras and lights. For natively built content, the exporter bakes the conversion into vertex data, transforms, instance matrices and animation curves. glTF-loaded content still carries right-handed data under the loader's mirror root; the exporter detects it and passes it through unchanged.
2. **Material mapping.** `PbrMaterialProps` is already glTF-shaped, so PBR export inverts the loader's import mappings field by field. `StandardMaterialProps` is converted to metallic-roughness with the Babylon.js conversion formulas.
3. **Images.** Every image is read back from the GPU and encoded as PNG, so its pixels are exactly what Lite samples.
4. **Sharing.** Geometry, materials, images and accessors are deduplicated in the output, matching the sharing the loader and engine maintain at runtime.

### Scope

The module is a leaf. It reads existing scene, engine and loader state, and changes no code outside `packages/babylon-lite/src/export-gltf/` except the one root re-export of `exportSceneAsGlb` in `index.ts`. Capabilities that would need a change anywhere else are **out of scope** and listed below, with what the exporter does instead. The design decisions behind them are deferred. The module's own tests, lab page and documentation are part of the module and do not count as outside changes.

**Out of scope: needs a change outside `export-gltf/`**

| Capability                                                                                                                                      | Why it needs an outside change                                                                                                                                                                                 | What the exporter does instead                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skins                                                                                                                                           | `SkeletonData` keeps no joint list and no inverse bind matrices. Only animation state holds them, and only for assets that have animation groups, so recovering them reliably needs the loader to retain them. | A skinned mesh exports unskinned: its rest geometry, no `JOINTS_*` / `WEIGHTS_*`, no `skins`, with a warning. Joint nodes and the animation channels that target them still export.    |
| Texture sampling                                                                                                                                | WebGPU cannot read a `GPUSampler`'s settings back. Recovering them needs a lookup in the engine's sampler pool or a descriptor stored on `Texture2D`.                                                          | No `sampler` is emitted, so readers apply glTF defaults (repeat wrapping, implementation-chosen filtering). Clamp, mirror and nearest sampling are lost.                               |
| Original image bytes                                                                                                                            | The loader decodes encoded images and discards the bytes.                                                                                                                                                      | Every image is read back from the GPU and encoded as PNG. JPEG, WebP and KTX2 sources become PNG.                                                                                      |
| Morph-target names                                                                                                                              | The loader keeps none.                                                                                                                                                                                         | `extras.targetNames` is not emitted.                                                                                                                                                   |
| Tangents, second UV set and vertex colors of loaded meshes                                                                                      | Only existing opt-ins keep these on the CPU: `enableDeviceLostSceneRecovery` (active at load) for all three, `enableGltfCpuTangents` for tangents. GPU vertex buffers cannot be read back.                     | Exported when an opt-in kept them; otherwise the attribute is omitted with a warning.                                                                                                  |
| Exact Standard `uvOffset` gating                                                                                                                | Whether the renderer applies `uvOffset` (only after `enableStandardUvOffset()`) is private to `standard-pipeline.ts`.                                                                                          | `uvOffset` exports whenever it is set.                                                                                                                                                 |
| Recognizing the loader root and camera fixup by identity                                                                                        | Needs load-time records.                                                                                                                                                                                       | Both are recognized by shape alone, so a loader root the application moved or rescaled exports as an ordinary node.                                                                    |
| Partial vertex updates (`updateMeshPositions`, `updateMeshNormals`, `updateMeshUvs`, `updateMeshUv2`, `updateMeshColors`, `updateMeshTangents`) | They write the GPU only and leave the CPU arrays stale.                                                                                                                                                        | The exporter reads the CPU arrays, so it exports the geometry from before such updates. `resizeMeshGeometry` and `updateMeshGeometry` replace the CPU arrays too and export correctly. |
| Loader conformance fixes (Known loader issues)                                                                                                  | Loader code.                                                                                                                                                                                                   | Not fixed here. The exporter always writes a BIN chunk, so its output reloads in Lite; an empty-scene export has no nodes and does not.                                                |

**Not exported, because Lite has no glTF counterpart or the state is outside this module:**

- `KHR_animation_pointer` channels, `KHR_materials_variants`, `KHR_node_visibility` (the `visible` flag), `KHR_xmp_json_ld` and `KHR_interactivity` / flow graphs.
- Environment and image-based lighting (`EXT_lights_image_based`), hemispheric lights, clustered lights and lightmaps.
- Node, shader, line and grid materials.
- Gaussian splats, vertex-animation textures, particles, sprites and text.
- Hand-posed bones (`enableBoneControl` overrides) and AnimationGroup playback state.
- Natively authored animation groups (`createPropertyAnimationGroup` and other groups without loader-retained glTF clip data); only glTF-clip groups export (Animations).
- Compressed or quantized output (Draco, meshopt, `KHR_mesh_quantization`), sparse accessors, and `KHR_texture_basisu` / `EXT_texture_webp` / `EXT_texture_avif` output.
- `.gltf` + `.bin` output.
- Cameras other than `scene.camera`.
- Spot `innerConeAngle`.
- Scene-level extras and morph-target tangent deltas.
- glTF `LINE_LOOP` / `TRIANGLE_FAN` modes, which the loader already draws as triangle lists.

## Public API Surface

### Entry point — `export-gltf/export-gltf.ts`

```typescript
/** Serialize a scene to a single binary glTF 2.0 (.glb) Blob.
 *
 *  Reads the scene's meshes, lights, camera, materials and animation groups. Image pixels are
 *  read back from the GPU and embedded as PNG. Resolves to a Blob of MIME type
 *  "model/gltf-binary". Treats the scene as read-only: every piece of scene state is read
 *  synchronously before the first `await`, so the render loop cannot change the result while the
 *  export is in flight. Valid before or after `registerScene`, but after `addToScene` (which sets
 *  parent links). Under a null engine, textured slots are omitted.
 *
 *  Content glTF cannot express, or that this exporter does not support yet (skins, texture
 *  sampling modes, original image bytes, …), logs a `console.warn` and degrades; see the
 *  architecture doc `docs/lite/architecture/60-gltf-exporter.md`.
 *
 *  @param scene - The scene to export.
 *  @returns A Blob holding the GLB file. */
export async function exportSceneAsGlb(scene: SceneContext): Promise<Blob>;
```

Semantics:

- **Read-only.** The scene renders identically before and after the call. The exporter writes to no scene, mesh, material or texture field.
- **Complete capture.** The export includes every mesh, every point/directional/spot light, the scene camera, and every glTF-clip animation group. It also includes transform hierarchies that are referenced only by animation channels (see Root collection). There is no filter parameter; to filter, callers restructure the scene (`removeFromScene`) before exporting.
- **Current pose.** Node TRS, thin-instance matrices, morph weights, material values and texture pixels export as they are at call time. Everything read from the scene is read synchronously before the first `await`, and every texture readback is submitted in that same synchronous step, so animation that runs while the export is in flight cannot tear the result (see State Machine). One exception: the glTF animation controller never writes TRS to skin joints, to skinned-mesh nodes, or to their ancestors (`excludedNodeIndices` in `gltf-animation.ts`). Those nodes therefore always export their rest pose, and their animated pose travels only in the exported animations.
- **Deterministic.** Two calls on an unchanged scene, in the same runtime, resolve to byte-identical Blobs (see Determinism).
- **Errors.** Recoverable issues log `console.warn` and degrade as described in this document. The promise rejects only when a GPU texture readback fails (see Warnings & Errors).
- **Concurrency.** Calls are independent. Every cache is per call.

### Internal contract types — `export-gltf/export-context.ts`, `export-gltf/export-buffers.ts`

The contract types are tagged `@internal`. The listings below keep their JSDoc short; the comments in the source carry the long form.

```typescript
// export-context.ts

/** The glTF document under construction. Every array starts empty; assembly writes only the non-empty ones. */
export interface GltfDraft {
    readonly asset: GltfAsset;
    /** Document-level extension payloads (`KHR_lights_punctual`). */
    readonly extensions: GltfJsonObject;
    /** Root node indices of `scenes[0]`. */
    readonly sceneNodes: number[];
    readonly nodes: GltfNode[];
    readonly meshes: GltfMesh[];
    readonly materials: GltfMaterial[];
    readonly textures: GltfTexture[];
    readonly images: GltfImage[];
    readonly cameras: GltfCamera[];
    readonly animations: GltfAnimation[];
}

/** Tight RGBA8 pixels of one texture's mip 0, row 0 first (storage order). */
export interface PixelData {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/** Row order of an emitted image relative to texture storage. */
export type RowOrder = "storage" | "reversed";

/** How a mesh's second UV set exports (see Materials, "UV states"). */
export type UvState = "uv1" | "uv0" | "lost";

/** A `KHR_texture_transform` payload in glTF terms. */
export interface SlotTransform {
    readonly offset: readonly [number, number];
    readonly scale: readonly [number, number];
    readonly rotation: number;
}

/** Where and how one material slot samples its texture. */
export interface SlotMapping {
    readonly texCoord: 0 | 1;
    readonly transform?: SlotTransform;
    readonly rowOrder: RowOrder;
    /** Channels to invert (`v → 255 − v`) in the emitted image; Standard bump slots only. */
    readonly invert?: "r" | "rg";
    /** Convert linear-format color RGB to glTF sRGB; alpha is unchanged. */
    readonly colorDecode?: "linear" | "gamma";
}

/** A texture slot recorded during capture. Resolution writes `owner[key]`, or leaves it unset when the pixels are unreadable. */
export interface PendingSlot {
    /** The JSON object that receives the textureInfo: a material, `pbrMetallicRoughness`, or an extension object. */
    readonly owner: GltfJsonObject;
    /** Member name in `owner`, e.g. "baseColorTexture". */
    readonly key: string;
    /** glTF slot string used as the image `name`, e.g. "baseColorTexture" or "clearcoatTexture". */
    readonly slot: string;
    /** The GPU texture, captured synchronously (the wrapper may change after capture). */
    readonly gpu: GPUTexture;
    readonly mapping: SlotMapping;
    /** Extra textureInfo members (`scale` for normal textures, `strength` for occlusion). */
    readonly extra?: Readonly<Record<string, number>>;
    readonly materialName: string;
    /** Set by fold resolution when the texture folded into factors instead (1×1 ORM). */
    cancelled?: boolean;
}

/** A 1×1 factor fold recorded during capture; the folded factors are written at resolution. */
export interface PendingFold {
    /** The `pbrMetallicRoughness` object that receives the folded factors. */
    readonly owner: GltfJsonObject;
    readonly kind: "baseColor" | "metallicRoughness";
    readonly gpu: GPUTexture;
    /** How the shader decodes the texel's RGB: sRGB curve (`-srgb` format), `^2.2` (`_gammaAlbedo` on a linear format), or byte / 255. Base color only. */
    readonly decode: "srgb" | "gamma" | "linear";
    /** The props' own factors: `[r, g, b, a]` (alpha includes the material alpha) or `[metallic, roughness]`. */
    readonly factor: readonly number[];
    readonly materialName: string;
    /** Base color only: the material neither blends nor alpha-tests, so the texel's alpha byte does not fold. */
    readonly opaque?: boolean;
    /** 1×1 ORM only: slots that export the texture as an image when it cannot fold. Resolution cancels them when the fold applies. */
    readonly fallbackSlots?: readonly PendingSlot[];
}

/** Decode-blit resources, created on the first blit of the call. */
export interface BlitResources {
    readonly layout: GPUBindGroupLayout;
    readonly module: GPUShaderModule;
    readonly pipelineLayout: GPUPipelineLayout;
    /** Target format → blit pipeline. */
    readonly pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
}

/** Per-call state shared by every export module. Discarded when the call resolves. */
export interface ExportContext {
    readonly engine: EngineContext;
    readonly doc: GltfDraft;
    readonly buffers: BufferBuilder;
    /** Exported scene object (node, folded mesh, light, camera) → glTF node index. */
    readonly nodeIndex: Map<object, number>;
    /** Same keys: whether the glTF node holds converted (left-handed source) data or pass-through right-handed data. */
    readonly nodeConvert: Map<object, boolean>;
    /** Source material (after getMaterialSource) → glTF material index, per mesh UV state. */
    readonly materialIndex: Map<Material, Map<UvState, number>>;
    /** GPUTexture → mip-0 pixels, read back once per call. Never rejects; resolves to null when unreadable. */
    readonly pixelCache: Map<GPUTexture, Promise<PixelData | null>>;
    /** GPU readback failures, in submission order. */
    readonly readbackErrors: unknown[];
    blit?: BlitResources;
    /** GPUTexture → settled pixels; filled by the settle step, read by resolution. */
    readonly resolvedPixels: Map<GPUTexture, PixelData | null>;
    readonly slots: PendingSlot[];
    readonly folds: PendingFold[];
    /** Callbacks that need resolved factors or slots (unlit, spec-gloss); run in registration order. */
    readonly afterResolve: (() => void)[];
    /** Content key (size, row order, channel ops, FNV-1a of the bytes) → glTF image indices with that key. */
    readonly imageIndex: Map<string, number[]>;
    /** glTF image index → its emitted RGBA bytes, kept until encoding. */
    readonly imagePixels: PixelData[];
    /** glTF image index → glTF texture index (one texture per image; samplers are out of scope). */
    readonly textureIndex: Map<number, number>;
    /** Typed-array identity → (conversion variant → accessor index). */
    readonly accessorIndex: Map<ArrayBufferView, Map<string, number>>;
    /** Primitive-list signature → glTF mesh index. */
    readonly meshIndex: Map<string, number>;
    /** glTF material indices with a texture slot sampling TEXCOORD_0. */
    readonly materialsUsingUv0: Set<number>;
    /** Vertex count → zero-filled TEXCOORD_0 accessor. */
    readonly zeroUvAccessors: Map<number, number>;
    readonly extensionsUsed: Set<string>;
    readonly extensionsRequired: Set<string>;
    /** Logs each distinct message once per call, as `[babylon-lite] glTF export: <message>`. */
    warn(message: string): void;
}

/** One glTF material extension writer. Writers form a static ordered array in export-materials.ts. */
export interface MaterialExtensionWriter {
    /** glTF extension name, e.g. "KHR_materials_clearcoat". */
    readonly name: string;
    /** Runs during capture (synchronous). When the material carries this extension's state, attaches
     *  its payload with `attachExtension` and captures texture slots through `captureTextureSlot`.
     *  Values that depend on resolved factors are written from a `ctx.afterResolve` callback. */
    write(ctx: ExportContext, material: PbrMaterialProps, out: GltfMaterial, uvState: UvState): void;
}

// Shared helpers (export-context.ts)

/** Create the per-call context. `generator` becomes `asset.generator`. */
export function createExportContext(engine: EngineContext, generator: string): ExportContext;

/** Attach `payload` as `owner.extensions[name]` and record the extension in `ctx.extensionsUsed`. */
export function attachExtension(ctx: ExportContext, owner: { extensions?: GltfJsonObject }, name: string, payload: GltfJsonObject): void;

/** JSON snapshot of user extras taken during capture. Values that are not JSON-serializable are dropped with a warning. */
export function snapshotExtras(ctx: ExportContext, extras: unknown, ownerName: string | undefined): unknown;

/** The cached accessor for (`source`, `variant`), built on first use. `variant` names how the source bytes were transformed. */
export function cachedAccessor(ctx: ExportContext, source: ArrayBufferView, variant: string, build: () => number): number;
```

```typescript
// export-buffers.ts

/** One accessor request. */
export interface AccessorDesc {
    readonly bufferView: number;
    readonly byteOffset?: number;
    readonly componentType: GltfComponentType; // 5121 | 5123 | 5125 | 5126
    readonly count: number;
    readonly type: GltfAccessorType; // "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4"
    readonly normalized?: boolean;
    readonly min?: number[];
    readonly max?: number[];
}

/** Collects bufferViews and accessors and lays out the single GLB BIN buffer. */
export interface BufferBuilder {
    /** The glTF `bufferViews` array; `byteOffset`s are written by `finalize`. */
    readonly bufferViews: GltfBufferView[];
    /** The glTF `accessors` array. */
    readonly accessors: GltfAccessor[];
    /** Snapshot `bytes` into a new bufferView and return its index. The bytes are copied on the call.
     *  The same view object with the same stride and target returns the existing index. */
    addBufferView(bytes: ArrayBufferView, byteStride?: number, target?: GltfBufferViewTarget): number;
    /** Record an accessor and return its index. */
    addAccessor(desc: AccessorDesc): number;
    /** Lay out every bufferView and return the BIN payload (length 0 when nothing was added). */
    finalize(): Uint8Array;
}

export function createBufferBuilder(): BufferBuilder;
/** Per-component minimum and maximum over `count` elements of `components` values each (zeros for zero elements). */
export function computeMinMax(data: ArrayLike<number>, components: number, count?: number): { min: number[]; max: number[] };
// Constants: UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125, FLOAT = 5126, ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963.
```

`exportSceneAsGlb` is the only public addition, re-exported by name from `packages/babylon-lite/src/index.ts` (root-only export map, pillar 4e). The contract types stay module-internal. Unit tests import them from the source modules directly, as other unit suites already do (for example `tests/lite/unit/gltf-interleave.test.ts`).

### glTF document typings — `export-gltf/export-gltf-types.ts`

The loader types the glTF JSON as `any`, so it has no schema typings to import. The exporter declares its own interfaces, covering only the members it writes: `GltfDocument`, `GltfProperty`, `GltfJsonObject` (a free-form `Record<string, unknown>` for extension and extras payloads), `GltfAsset`, `GltfScene`, `GltfNode`, `GltfAttributes`, `GltfMesh`, `GltfPrimitive`, `GltfMaterial`, `GltfPbrMetallicRoughness`, `GltfTextureInfo`, `GltfNormalTextureInfo`, `GltfOcclusionTextureInfo`, `GltfTexture`, `GltfImage`, `GltfCamera` (with `GltfCameraPerspective` and `GltfCameraOrthographic`), `GltfAnimation`, `GltfAnimationChannel`, `GltfAnimationChannelTarget`, `GltfAnimationSampler`, `GltfAccessor`, `GltfBufferView`, `GltfBuffer`, and the literal types `GltfComponentType`, `GltfAccessorType` and `GltfBufferViewTarget`. Member names and value types follow the glTF 2.0 JSON schema, and every member is optional except where the schema requires it. The file is type-only and contributes zero runtime bytes.

---

## Internal Architecture

### Design rules

- **Opt-in by import.** The exporter is reached only through `exportSceneAsGlb`. No module in `export-gltf/` runs code at import time, and there is no global registry: the extension writers are a static ordered list. Scenes without the import carry zero exporter bytes.
- **Read-only.** The exporter reads plain-data interfaces and mutates nothing. All conversions act on copies. Retained CPU arrays are often views into the loaded GLB buffer, so the exporter never writes to them. Engine-owned caches are not written either. GPU work is limited to texture readback: every texture and buffer it creates is transient and destroyed before the call resolves, and the blit pipeline objects are dropped with the per-call context.
- **Omit defaults.** Values equal to their glTF defaults are omitted (see the consolidated table). Materials, textures, images and cameras are emitted only when referenced.
- **Warn and continue.** Content outside the exportable set logs a `console.warn` and degrades to a defined fallback. Every message starts with `[babylon-lite] glTF export: ` and logs once per call. The only thrown error is a GPU readback failure (see Warnings & Errors).
- **Deterministic.** The same scene exports to a byte-identical GLB: stable traversal order, insertion-ordered maps, a fixed writer order, fixed JSON member order, and no time- or randomness-dependent output.
- **Leaf module.** Nothing outside `export-gltf/` changes except the root re-export (see Scope).
- **Two tolerances.** `export-handedness.ts` holds both. They are not interchangeable.
    - **Omission tolerance**, `OMIT_EPSILON = 1e-9`. It absorbs float noise when deciding whether a value equals its glTF default: node TRS and `matrix`, light and camera node transforms, base color and emissive values, and the identity tests behind light collapse and mesh folding. Small but real values (sub-millimetre offsets, tiny rotations) are therefore never dropped.
    - **Detection tolerance**, `EXPORT_EPSILON = 0.001`, written `≈` in this document. It is used only by shape-recognition heuristics: the loader root `(−1,1,1)`, the camera fixup shape and its pristine check, whether a matrix is TRS-decomposable, whether a thin-instance attribute deviates from identity, and orthographic off-center bounds.

### Inputs read from the scene

This table is the exporter's full input surface. Extending the exporter starts by adding a row here.

| Source                                                   | Fields read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SceneContext`                                           | `surface` (`surface.engine`, `surface.canvas`), `meshes`, `lights`, `camera`, `animationGroups`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SceneNode` (incl. `TransformNode`, `Mesh`, `LightBase`) | `name`, `children`, `parent`, `position` / `rotationQuaternion` / `scaling` (observable; read `.x .y .z [.w]`), `_localMatrix`, `worldMatrix` (world-placed roots, camera and light placement), `metadata.gltf.extras`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Mesh`                                                   | the above, plus `material`, `_authoredSign`, `_topology`, `_primitive.topology`, `_flatNormal`, `_cpuPositions`, `_cpuNormals`, `_cpuTangents`, `_cpuUvs`, `_cpuUv2s`, `_cpuColors`, `_cpuGpuIndices`, `_cpuIndices`, `_gpu` (presence marks a mesh; `_gpu.tangentBuffer` / `uv2Buffer` / `colorBuffer` presence only), `skeleton` (presence only), `morphTargets`, `thinInstances`                                                                                                                                                                                                                                              |
| `MorphTargetData`                                        | `targets[].positions`, `targets[].normals`, `weights`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ThinInstanceData`                                       | `matrices`, `count`, `colors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Material`                                               | via `getMaterialSource`: `name`, `metadata.gltf.extras`, `_buildGroup._materialFamily` (through `getMaterialFamily`), and the per-family props below                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PbrMaterialProps`                                       | `baseColorTexture`, `baseColorFactor`, `alpha`, `alphaBlend`, `_alphaCutOff`, `doubleSided`, `metallicFactor`, `roughnessFactor`, `ormTexture`, `occlusionStrength`, `occlusionTexture`, `normalTexture`, `normalTextureScale`, `emissiveTexture`, `_emissiveColor`, `specGlossTexture`, `_gammaAlbedo`, `reflectance`, `_unlit`, `_unlitColor`, `_clearCoat`, `_sheen`, `_iridescence`, `_anisotropy`, `_subsurface`, `_transmissive`, `_specularWeight`, `_metallicF0Factor` (only as the specular-weight fallback), `_metallicReflectanceColor`, `_metallicReflectanceTexture`, `_reflectanceTexture`, `_hasUvTx`, `_uv2Mask` |
| `StandardMaterialProps`                                  | `diffuseColor`, `alpha`, `specularPower`, `emissiveColor`, `diffuseTexture`, `diffuseCoordIndex`, `_emissiveTexture`, `_bumpTexture`, `bumpLevel`, `_ambientTexture`, `ambientCoordIndex`, `_opacityTexture`, `alphaCutOff`, `uvScale`, `uvOffset`, `_hasUvTx`, `backFaceCulling`, `disableLighting`                                                                                                                                                                                                                                                                                                                             |
| `Texture2D`                                              | `texture` (`format`, `usage`, `dimension`, `depthOrArrayLayers`, `sampleCount`, `width`, `height`), `width`, `height`, `invertY`, `_hasTx`, `_texCoord` (iridescence slots only); transform through `getTextureTransform`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PointLight` / `DirectionalLight` / `SpotLight`          | `lightType`, `name`, `parent`, `position`, `rotationQuaternion`, `direction` (directional, spot), `diffuse`, `intensity`, `range` (point, spot), `angle`, `exponent` (spot), `worldMatrix`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Camera` (`FreeCamera` / `ArcRotateCamera`)              | `name`, `worldMatrix`, `parent`, `fov`, `nearPlane`, `farPlane`, `viewport` (through `getEffectiveAspectRatio`), `ortho` (`halfHeight`, `left`, `right`, `top`, `bottom`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AnimationGroup`                                         | `name`, `_gltfMixer[0]` (the clip), `targetedAnimations[].target`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EngineContext`                                          | `_device` (readback; absent on a null engine; `limits.maxBufferSize` when present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

State outside this table is not part of the input contract. The corresponding glTF output is absent, without a warning, unless a rule below says otherwise. Examples: `visible` (and therefore `KHR_node_visibility`), `AssetContainer.materialVariants`, `xmpMetadata`, clustered lights, environment and image-based lighting, fog, and additional `AssetContainer.cameras`.

### Module map

There is one module per glTF entity, plus helpers for concerns that cut across entities. Modules communicate only through the `ExportContext`. Entity modules import helpers, and the entry orchestrates.

```
export-gltf/
  export-gltf.ts                          entry: exportSceneAsGlb, phase orchestration, JSON assembly
  export-gltf-types.ts                    glTF 2.0 JSON interfaces (type-only)
  export-context.ts                       ExportContext and contract types, createExportContext, attachExtension, snapshotExtras, cachedAccessor
  export-handedness.ts                    LH↔RH math, winding rule, tolerances (EXPORT_EPSILON, OMIT_EPSILON)
  export-buffers.ts                       BufferBuilder: bufferViews, accessors, alignment, min/max; component constants
  export-glb.ts                           GLB container framing
  export-nodes.ts                         root collection and partitioning, node traversal, TRS/matrix emission, mesh grouping
  export-geometry.ts                      primitives, attributes, indices, morph targets, zero-UV synthesis
  export-materials.ts                     material dispatch, PBR core, Standard→MR, writer sweep, fold resolution
  export-material-slots.ts                PBR slot helpers: UV selection, slot capture, _uv2Mask bits, default-omission setters
  export-textures.ts                      texture slot capture and resolution, textureInfo
  export-images.ts                        readback, decode blit, row order, content dedup, PNG encode step
  export-png.ts                           PNG encoder (CRC-32, zlib via CompressionStream)
  export-cameras.ts                       camera node and projection, fixup detection
  export-animations.ts                    animation groups → glTF animations, collectAnimatedNodes
  ext/export-ext-lights-punctual.ts       KHR_lights_punctual
  ext/export-ext-instancing.ts            EXT_mesh_gpu_instancing
  ext/export-ext-texture-transform.ts     KHR_texture_transform
  ext/export-ext-unlit.ts                 KHR_materials_unlit
  ext/export-ext-emissive-strength.ts     KHR_materials_emissive_strength
  ext/export-ext-clearcoat.ts             KHR_materials_clearcoat
  ext/export-ext-sheen.ts                 KHR_materials_sheen
  ext/export-ext-iridescence.ts           KHR_materials_iridescence
  ext/export-ext-anisotropy.ts            KHR_materials_anisotropy
  ext/export-ext-ior.ts                   KHR_materials_ior
  ext/export-ext-specular.ts              KHR_materials_specular
  ext/export-ext-transmission.ts          KHR_materials_transmission
  ext/export-ext-volume.ts                KHR_materials_volume
  ext/export-ext-dispersion.ts            KHR_materials_dispersion
  ext/export-ext-diffuse-transmission.ts  KHR_materials_diffuse_transmission
  ext/export-ext-spec-gloss.ts            KHR_materials_pbrSpecularGlossiness
```

The 13 material writers are assembled into `const MATERIAL_EXTENSION_WRITERS: readonly MaterialExtensionWriter[]` in `export-materials.ts`, in this order: unlit → emissive-strength → clearcoat → sheen → iridescence → anisotropy → ior → specular → transmission → volume → dispersion → diffuse-transmission → spec-gloss. Each file exports one writer object (`unlitWriter`, `clearcoatWriter`, …). The order is part of the output contract: it fixes the `extensionsUsed` ordering and the order of `afterResolve` callbacks.

Internal imports are static. The tree-shaking boundary is the feature itself: scenes without the exporter import carry none of its bytes.

### `BufferBuilder` — `export-buffers.ts`

- `addBufferView(bytes, byteStride?, target?)` copies the bytes at the call, so later writes to the source never reach the output, and records a bufferView with a deferred `byteOffset`. It returns the bufferView index. The same view object with the same stride and target returns the same index.
- `addAccessor(desc)` records an accessor that references a bufferView index, with `componentType`, `count`, `type`, and optional `byteOffset` (written only when non-zero), `normalized` (written only when true), `min` and `max`.
- `finalize()` orders bufferViews by descending alignment need (`byteLength % 4 === 0` → 4, `% 2 === 0` → 2, else 1; this is the Babylon.js packing rule). The sort is stable. It concatenates the views in that order with no padding, assigns offsets (`byteOffset` is omitted on the view placed at offset 0), and returns the BIN payload. The sort alone satisfies glTF's alignment rules: every view whose length is a multiple of 4 starts at a 4-aligned offset, and every view whose length is a multiple of 2 at a 2-aligned one. Every emitted vertex attribute, matrix and float array has a length that is a multiple of 4, as glTF's 4-byte vertex-attribute rule requires. All data targets `buffers[0]`. This matches Babylon.js.

`min`/`max` come from `computeMinMax`, per component, over the emitted (converted) data, for every `POSITION` attribute accessor, every morph-target `POSITION` accessor, and every animation input accessor. These are the places where the glTF specification requires them. Zero elements give zero bounds.

Float-accessor cache variants include component count, element count and whether bounds are required, so shared source arrays cannot substitute a NORMAL or UV descriptor for a POSITION descriptor.

### Root collection and partitioning — `export-nodes.ts`

`collectRoots(ctx, scene, animated, cameraFixup)` returns a `NodeSweep`:

```typescript
interface ExportRoot {
    readonly node: SceneNode;
    /** Converting (Lite left-handed data) or pass-through (right-handed data under a stripped loader root). */
    readonly convert: boolean;
    /** The root has a parent that does not export (a camera, a light or another world-matrix provider); it exports at its current world transform. */
    readonly world: boolean;
}
interface NodeSweep {
    readonly roots: readonly ExportRoot[];
    /** Parent → children linked only through `child.parent` (missing from `parent.children`). */
    readonly extras: ReadonlyMap<object, readonly SceneNode[]>;
    /** Nodes bound by a glTF-clip node channel; they must export TRS, never `matrix`. */
    readonly animated: ReadonlySet<object>;
    /** Nodes that never export (the scene camera's fixup node). */
    readonly skipped: ReadonlySet<object>;
    /** `metadata.gltf.extras` of the first stripped loader root that carries extras. */
    readonly assetExtras?: unknown;
}
```

Helper predicates: `isLight(o)` (`"lightType" in o`), `isCamera(o)` (`"nearPlane" in o`), `isMesh(o)` (`"_gpu" in o`), and `isExportableNode(o)`: an object with `rotationQuaternion` and a `children` array that is neither a light nor a camera. Any other object a node can be parented to (a camera, a light, some other world-matrix provider) is **foreign**.

1. **Seed and walk.** Walk the `parent` chain upward from each of these seeds: every mesh in `scene.meshes`; every exportable light in `scene.lights`, through its parent when that is an exportable node; the scene camera, through its parent when that is an exportable node and not the camera's fixup; and every animation-bound node (`animated`, the targets of translation, rotation, scale and weights channels of a defined `_gltfMixer` clip). Collect the distinct topmost ancestors in first-encounter order: meshes first, then lights, then the camera, then animation targets. Seeding from bound targets keeps channel-only hierarchies in the export, such as an animated meshless `TransformNode` root.

    The walk climbs while the parent is an exportable node, so it stops below a foreign parent. A parent cycle logs `Node "<name>" is part of a parent cycle; exporting the cycle from this node.` and the walk stops at the node whose parent is already on the path.

    **Membership is defined by `parent`.** The `SceneNode.parent` setter does not update `children`, so the two can disagree:
    - A node listed in `X.children` belongs to `X` only while its `parent === X`. `removeFromScene` clears `parent` without editing the old parent's `children`, so a removed node stays listed but is skipped, together with its subtree.
    - A node whose `parent` is `X` but which is missing from `X.children` (code assigned `parent` directly) is recorded as an _extra child_ of `X` while walking each mesh or animation-target seed's chain, in first-encounter order. Light and camera seeds record no extras.

    The depth-first sweep visits `X`'s qualifying `children` first, then its extras. It skips lights and cameras (they export from their own seeds) and the camera fixup. A node reached a second time is never linked under a second parent: the hierarchy exports as a strict tree.

2. **Partition.** Classify each collected root, skipping the camera fixup:
    - **Foreign-parented root.** A root whose `parent` is still set after the walk because it is a foreign object is `world: true`. (A root where a parent cycle stopped the walk is not: a cycle has no world matrix, so it exports with its local transform in the converting state.) It exports in the converting state at its current world transform (see Nodes), with the warning `Node "<name>" is parented to a camera, light or other non-node object; exporting it as a scene root at its current world transform.`

        A foreign-parented root that is also an animation-channel target (in `animated`) cannot bake its world transform: glTF channel keys replace a node's local TRS, so the parent's transform would be lost on playback. It exports instead under an **anchor**: an unnamed scene-root node, appended to `scenes[0].nodes` in the root's place, whose only child is the root. The anchor's transform is the foreign parent's current `worldMatrix`, written like any other `M` (see Nodes: `matrix` when decomposable, else the nearest TRS with the shear warning); the root itself exports its local transform as TRS, so `anchor · local` equals its world transform. The warning is `Node "<name>" is an animation target parented to a camera, light or other non-node object; exporting it under a scene-root node at the parent's current world transform.` Non-animated foreign-parented roots keep the world-placed export above.

    - **Loader conversion root.** A parentless root matches when all of the following hold:
        - it is not a mesh (`_gpu` absent), and `_localMatrix` is unset;
        - `position ≈ (0,0,0)`, `rotationQuaternion ≈ identity`, `scaling ≈ (−1,1,1)`;
        - no `_gltfMixer` channel binds it (it is not in `animated`).

        A matching root is **stripped**, and its children export in the **pass-through** state. This inverts `createTransformNode("__root__", 0,0,0, 0,0,0,1, −1,1,1)` in `load-gltf.ts`. The stripped root's `metadata.gltf.extras` (the loader's home for `asset.extras`) becomes `asset.extras`; when several stripped roots carry extras, the first in root order wins.

    - **Every other root** exports in the **converting** state. A loader root that the application parented under its own node is not a root, so it is not stripped: it exports as an ordinary node with scale `(−1,1,1)` inside the converting pass, which is geometrically exact (its glTF children are converted along with everything else).
3. **Export.** Each root exports depth-first. Root node indices concatenate into `scenes[0].nodes`.

A per-pass `convert: boolean` flag rides on the recursion and is recorded per exported object in `ctx.nodeConvert`, so cameras, lights and animations later read the state of the node they attach to. Every spatial emission site (TRS, vertex data, instance matrices, camera and light orientation, animation samples) branches on it once.

Lights and cameras always export from their own seeds (Lights, Cameras) and attach to their parent's exported node. The glTF loader links them to their node only through `parent`. Native code may also list them in a `children` array (`addToScene` then sets their `parent`), which is why the sweep skips them.

When the camera's parent is fixup-shaped (see Cameras), the camera seed contributes no root and the fixup node never exports. The camera attaches under the fixup node's parent only if that parent is exported through another seed; otherwise it exports from its world matrix as a parentless camera. This covers the loader's `<camera>_bakedNode`: a parentless node whose matrix already includes the root flip, which neither the converting nor the pass-through rule could emit correctly.

### Coordinate-system policy — `export-handedness.ts`

Lite is left-handed and column-major (module 21). glTF is right-handed and Y-up, with CCW front faces and −Z-forward cameras and lights. Converting passes bake a mirror across the YZ plane (negate X). Pass-through passes hold data that is already right-handed and emit it as it is, which keeps load→export round trips byte-stable.

Let `C = diag(−1, 1, 1, 1)`, so `C⁻¹ = C`.

**Vertex data (converting passes).** On copied arrays, negate component 0 of every `POSITION`, `NORMAL` and `TANGENT` element, and of every morph position and normal delta. Renormalize `NORMAL` and `TANGENT` xyz; zero-length vectors are left as they are. **Negate tangent `w`:** a mirror reverses the bitangent's handedness, since `cross(C·n, C·t) = −C·cross(n, t)`. Babylon.js keeps `w` (see the Equivalence Map). Morph normal deltas are only mirrored, not renormalized. UVs and colors are untouched.

**Vertex data (pass-through).** Attribute arrays are emitted as the source array itself, with one repair. When every `NORMAL` and `TANGENT` xyz is unit length within 0.0005 (glTF-Validator's `ACCESSOR_VECTOR3_NON_UNIT` tolerance), the source bytes export verbatim, which keeps round trips byte-stable. Otherwise the array is copied and each non-zero vector whose length is outside that tolerance is renormalized; zero vectors and tangent `w` are left alone. Loaded assets do contain such normals (LittlestTokyo). Positions, UVs, colors and morph deltas are always verbatim.

**Translation.** `(x, y, z) → (−x, y, z)`.

**Rotation.** The change of basis `quat(C · mat(q) · C)` is the linear map `L(x, y, z, w) = (x, −y, −z, w)`, up to overall sign.

- _Static rotations_ in converting passes (node TRS, instance rotations, light and camera nodes): apply `L`, make the result canonical with the Babylon.js sign pattern, then normalize. Pick the pivot component: when `x² + y² > 0.5`, the larger of |x| and |y|; otherwise the larger of |z| and |w|. Ties go to the later component (y over x, w over z), matching Babylon.js's strict `>` comparisons; exact ties are common, for example in 90° rotations. Then flip the whole quaternion's sign if the pivot is negative. Applied to the input, this gives: x-pivot `(|x|, −s·y, −s·z, s·w)`; y-pivot `(−s·x, |y|, s·z, −s·w)`; z-pivot `(−s·x, s·y, |z|, −s·w)`; w-pivot `(s·x, −s·y, −s·z, |w|)`, where `s` is the sign of the input component that becomes the pivot (x, y, z or w respectively). The pivot is chosen on the `L`-mapped quaternion, whose |x|, |y|, |z|, |w| equal the input's.
- _Static rotations in pass-through passes_ (node TRS) are emitted verbatim when unit length (`|len − 1| ≤ 1e-6`) and normalized otherwise. A zero quaternion becomes identity.
- _Animation rotation keys and CUBICSPLINE tangents:_ apply `L` only, with no sign canonicalization. A per-key sign flip would break hemisphere continuity between keys and corrupt spline tangents. Non-spline rotation keys of either pass are additionally renormalized when `|len − 1| > 0.0005` (see Animations).

**Scale.** Unchanged.

**Matrices** (`_localMatrix` nodes, world-placed roots and anchors): `M′ = C · M · C`, which negates the entries where exactly one of row and column is 0.

**Rotate180Y.** `R(q) = q ⊗ (0, 1, 0, 0)`, which is `(x, y, z, w) → (−z, w, x, −y)`. This map is linear, so it applies to animation keys and tangents too.

**Direction to rotation.** `rotTo(d)` is the unit quaternion rotating `a = (0, 0, −1)` onto the normalized `d`. Set `q = (d.y, −d.x, 0, 1 − d.z)` and normalize it. When `1 − d.z < 1e−6` (d ≈ (0,0,1)), use `(0, 1, 0, 0)`. A zero `d` gives the identity.

### Winding order

glTF front faces are counter-clockwise in the data: a front triangle's geometric normal `(p₁ − p₀) × (p₂ − p₀)` points along its vertex normals, and readers flip culling under negative-determinant nodes. Lite's native generators wind the other way: `createPlane`'s first triangle has geometric normal +Z and vertex normal −Z. Lite renders those with `frontFace: "ccw"` under positive-determinant world matrices, and renders glTF data the same way under the loader's negative-determinant root. `Mesh._authoredSign` records which convention a mesh uses: −1 for glTF-loaded meshes (`load-gltf.ts`, `gltf-share.ts`; also the USD loader), and +1 or unset for native ones. Negating X flips the data's winding relative to its normals, so per primitive:

| Pass         | `_authoredSign` | Index order                                       |
| ------------ | --------------- | ------------------------------------------------- |
| converting   | `+1` / unset    | verbatim                                          |
| converting   | `−1`            | reversed: triangles are emitted as `(i₀, i₂, i₁)` |
| pass-through | `−1`            | verbatim                                          |
| pass-through | `+1` / unset    | reversed                                          |

That is, reverse exactly when `(_authoredSign ?? 1) === (convert ? −1 : +1)`. The loader's mirrored-node `frontFace: "cw"` stamp is render state and does not affect export.

Reversal happens on a copy. A triangle list swaps each triangle's last two indices. A triangle strip that requires a reversal is **expanded** into a reversed triangle list (mode 4): strip triangle `i` is `(s[i], s[i+1], s[i+2])` for even `i` and `(s[i+1], s[i], s[i+2])` for odd `i`, and each becomes `(a, c, b)`; degenerate strip triangles are kept. A reversed list whose index count is not a multiple of 3 drops the trailing one or two indices. A reversed list or strip with fewer than 3 indices (or vertices, when non-indexed) has nothing to draw, and the mesh contributes no primitive. An un-reversed strip, indexed or not, exports verbatim with mode 5. Nothing throws. Point and line topologies emit verbatim.

---

### Scene & node export — `export-nodes.ts`

Depth-first per root. For each `SceneNode`:

1. **Dedup.** `nodeIndex` maps each exported object to one glTF node. A node that is reached again is not linked under a second parent (see Root collection).
2. **Create.** Set `node.name` from `name` when it is non-empty. The loader's synthetic names (`node_<i>`, `gltf_mesh_<i>`) cannot be told apart from authored ones and export as names. Set `node.extras` from `metadata.gltf.extras` when present; this inverts the loader's extras promotion (`gltf-feature-extras.ts`). Extras are snapshotted through a JSON round trip at capture, so later writes cannot reach the output. A value that is not JSON-serializable is dropped with `Extras of "<name>" are not JSON-serializable; exporting without them.` Node members are written in the order: `name`, transform, `mesh`, `extensions`, `extras`, `children`. A `camera` reference (camera collapse) and a collapsed light's `extensions` are attached after the node was created, so they follow `children`.
3. **Transform.** Let `M` be the node's `_localMatrix` when set (see `scene-node.ts`: either a glTF `matrix` node, or the exact matrix `setParent` keeps, which can carry shear that TRS cannot represent). For a world-placed root (`world: true`), `M` is the node's `worldMatrix` instead; an animated one is anchored instead (see Root collection) and keeps its local `M`.
    - When `M` exists and is TRS-decomposable (recomposing `decomposeMat4(M)` is ≈ `M`) and the node is not an animation-channel target: emit `node.matrix` (`C·M·C` in converting passes, verbatim in pass-through), omitted when within 1e-9 of identity.
    - When `M` exists and the node is an animation-channel target, glTF forbids `matrix`: emit the TRS of `decomposeMat4(M)`, converted per the policy.
    - When `M` is not TRS-decomposable, glTF-Validator rejects it (`NODE_MATRIX_NON_TRS`): emit the same TRS and log `Node "<name>" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.`
    - Otherwise emit TRS from `position` / `rotationQuaternion` / `scaling`, converted per the policy. Each component is omitted when within 1e-9 of its default (`[0,0,0]`, identity of either sign, `[1,1,1]`). Converting rotations are canonical and normalized; pass-through rotations are verbatim when unit length, else normalized.
4. **Mesh assembly.** Only a non-`Mesh` `TransformNode` absorbs meshes. A `Mesh` node is the sole contributor to its own glTF mesh, and its children export as ordinary child nodes. A `TransformNode`'s `Mesh` children fold into the node's glTF mesh, one primitive each and in child order. This inverts the loader, which attaches one Lite `Mesh` per glTF primitive under the node's TransformNode. A `Mesh` child folds only when all of these hold:
    - it has no `_localMatrix`, no children (listed or parent-only), and is not an animation-channel target;
    - its TRS is identity within 1e-9;
    - it agrees with the first contributor on thin instances (both inactive, or the same `matrices` array, the same `count`, and the same `colors` array or no `colors` on both; the loader shares one matrices array across a node's primitives and sets no colors);
    - it agrees on morph targets (both without, or the same target count and equal current `weights`). A mesh whose targets the geometry step would drop (see Geometry) counts as without, because glTF requires every primitive of a mesh to have the same number of morph targets.

    These fences exist because `EXT_mesh_gpu_instancing` and `mesh.weights` are single-valued per node or mesh, and a mesh's primitives must agree on their morph target count. Loader output always satisfies them. A child that fails a fence becomes its own node with a single-primitive mesh, as does a `Mesh` with a non-identity transform or with children, and a standalone `Mesh` root.

    A folded mesh is recorded in `nodeIndex` (and `nodeConvert`) against the absorbing node's index, so animation channels and light/camera attachment resolve to the holding node. A contributor with no exportable geometry adds no primitive; a node with no primitives gets no mesh. `mesh.name` is the first non-empty contributor name. Mesh `extras` come from the first contributor whose `metadata.gltf.extras` is defined and is a different object (`!==`) from the absorbing node's extras. The loader promotes the first of primitive, mesh or node extras onto each Lite mesh, by reference; a Lite mesh holding its node's extras object came from the node and does not count as mesh extras. Mesh `weights` come from the first contributor that has morph targets. The first contributor with active thin instances supplies `EXT_mesh_gpu_instancing`.

5. **Mesh dedup.** Contributors are exported to primitives first (geometry, then material, then zero-UV synthesis). The primitive list, morph weights, mesh name and mesh extras are serialized into a signature. An identical signature reuses the existing glTF mesh, so nodes that share loader-shared geometry and materials reference one mesh.
6. **Children** are written only when non-empty: the node's qualifying `children` first, then its parent-only extras, excluding folded meshes.

Nodes export regardless of `visible`; visibility is runtime presentation state.

---

### Geometry export — `export-geometry.ts`

#### Attributes

One glTF primitive is emitted per Lite `Mesh`, from the retained CPU arrays. Interleaved glTF meshes materialize tight copies through their lazy de-stride getters. Empty arrays count as absent:

| glTF attribute | Source          | Type / componentType | Notes                                                                                                                                      |
| -------------- | --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSITION`     | `_cpuPositions` | VEC3 / FLOAT         | min/max on the emitted data                                                                                                                |
| `NORMAL`       | `_cpuNormals`   | VEC3 / FLOAT         | omitted when `_flatNormal === true`; converting: X negated and renormalized; pass-through: verbatim when unit within 0.0005, else repaired |
| `TANGENT`      | `_cpuTangents`  | VEC4 / FLOAT         | xyz like normals; `w` negated in converting passes, verbatim in pass-through                                                               |
| `TEXCOORD_0`   | `_cpuUvs`       | VEC2 / FLOAT         | verbatim                                                                                                                                   |
| `TEXCOORD_1`   | `_cpuUv2s`      | VEC2 / FLOAT         | when retained                                                                                                                              |
| `COLOR_0`      | `_cpuColors`    | VEC4 / FLOAT         | RGBA                                                                                                                                       |

- **Floats.** Retained colors are `Float32Array`: the loader normalizes integer sources and widens VEC3 colors to RGBA at load. Attribute emission is therefore float throughout.
- **Skinned meshes.** `JOINTS_*` and `WEIGHTS_*` are never emitted (see Skinned meshes).
- **Flat shading.** `_flatNormal` marks primitives that had no `NORMAL` in the source. Omitting the generated normals keeps them flat-shaded on reimport, as glTF requires.
- **Synthesized UVs.** A source primitive without `TEXCOORD_0` gets zero-filled UVs at load. There is no flag for this, so those UVs export. A native mesh without UVs is handled by the zero-UV rule below.
- **Length check.** Every present attribute array must hold exactly `components × vertexCount` values, where the vertex count is `floor(positions.length / 3)`. A mismatching array is omitted with `Mesh "<name>" has <label> whose length does not match its positions; exporting the mesh without them.`, where `<label>` is `normals`, `tangents`, `UVs`, `second UV set` or `vertex colors`. A mismatching second UV set puts the mesh in the `"lost"` UV state.

**Retention gate.** `_cpuPositions`, `_cpuNormals`, `_cpuUvs` and `_cpuIndices` are always retained for glTF meshes. `_cpuTangents`, `_cpuUv2s`, `_cpuColors` and `_cpuGpuIndices` are retained only by existing opt-ins that were active at load time: `enableDeviceLostSceneRecovery` keeps all four, and `enableGltfCpuTangents` keeps tangents. The exporter adds no retention of its own (see Scope). When a mesh has a non-null `_gpu.tangentBuffer`, `uv2Buffer` or `colorBuffer` but no matching CPU array, the attribute is omitted and the exporter logs `Mesh "<name>" has <label> on the GPU only; exporting the mesh without them.` (the label is `tangents`, `a second UV set` or `vertex colors`). A GPU-only second UV set puts the mesh in the `"lost"` UV state.

**Stale CPU arrays.** The partial-update helpers (`updateMeshPositions` and its siblings, listed under Scope) write only the GPU buffers. The exporter cannot detect this and exports the CPU arrays, which hold the geometry from before those updates.

A mesh with no `_cpuPositions` logs `Mesh "<name>" has no retained CPU geometry; exporting its node without a mesh.` and contributes a transform-only node. A mesh whose positions are empty, or whose index list is empty, contributes no mesh silently. A mesh with positions but no (or an empty) `_cpuNormals`, or with `_flatNormal`, omits `NORMAL`.

Accessors are cached per (typed-array identity, conversion variant) through `cachedAccessor`. The variant encodes the pass kind, the attribute kind and the winding flip. Each emitted array becomes one tightly packed bufferView, with `target` 34962 for attributes and 34963 for indices.

#### Indices and mode

- **Source.** Indices come from `_cpuGpuIndices` when retained, otherwise from `_cpuIndices`. The winding rule applies on a copy when a reversal is needed.
- **Index width.** A retained 32-bit `_cpuGpuIndices` stays UNSIGNED_INT. Every other source is emitted as UNSIGNED_SHORT when every index is below 65535, and as UNSIGNED_INT otherwise. 65535 is the 16-bit primitive-restart value, so a retained 16-bit array that contains it widens to 32-bit. This narrows the loader's 32-bit `_cpuIndices` for small meshes, which is why 16-bit width needs no opt-in.
- **Non-indexed meshes.** Every loader- or factory-built mesh is indexed: glTF primitives without indices get loader-synthesized sequential indices. A hand-assembled mesh lacking both index arrays exports a non-indexed primitive (no `indices`). If such a triangle list or strip requires a winding reversal, the exporter synthesizes the sequence `0, 1, 2, …` for the vertices and reverses it like an indexed source (`(0, 2, 1, 3, 5, 4, …)` for a list). The result is cached against the position array under a synthesized-index variant.
- **`primitive.mode`** uses the glTF numeric modes, and is omitted when it is 4 (TRIANGLES, the default). It is resolved in this order:
    1. `Mesh._topology`, when set. Codes 1 (points), 2 (lines), 3 (line strip) and 4 (triangle strip) map to glTF modes 0, 1, 3 and 5. Today only `createLineSystem` sets this field (to 2).
    2. Otherwise `Mesh._primitive?.topology`. `"point-list"`, `"line-list"`, `"line-strip"` and `"triangle-strip"` map to 0, 1, 3 and 5.
    3. Otherwise mode 4.

    A triangle strip that needs a winding reversal exports as a reversed triangle list, so its mode is 4. glTF `LINE_LOOP` and `TRIANGLE_FAN` sources cannot reappear: the loader draws them as triangle lists over the raw indices (as Babylon.js does), and that is what is exported.

- **Unmapped materials.** A material family outside the dispatch table leaves `primitive.material` unset, with a warning (see Materials).

#### UV-less meshes

Lite's `uploadMeshToGPU` binds a zero-filled UV buffer to a mesh without UVs, so a textured material samples texel (0, 0) everywhere. glTF needs the attribute for that to survive. When a primitive has no `TEXCOORD_0` and its glTF material has a texture slot with `texCoord: 0` (`ctx.materialsUsingUv0`, filled when the material is emitted), the exporter adds a zero-filled `TEXCOORD_0` accessor (VEC2 / FLOAT, `target` 34962). Accessors are shared per vertex count (`ctx.zeroUvAccessors`).

#### Morph targets

A mesh with `morphTargets` emits `primitive.targets`, one entry per `morphTargets.targets[t]`:

- `POSITION`: VEC3 / FLOAT deltas from `positions`, verbatim in pass-through and with X negated in converting passes, with min/max.
- `NORMAL`: VEC3 / FLOAT deltas when `normals` is non-null, under the same rule (X negated, not renormalized), without min/max. Normal deltas export only when the primitive exports `NORMAL`, because glTF requires a base attribute for every morphed one; otherwise they are omitted silently. A `normals` array whose length is not `3 × vertexCount` is omitted with the length warning (label `morph-target normals`).

If any target's `positions` length differs from `3 × vertexCount`, all targets are dropped with `Mesh "<name>" has morph targets whose length does not match its positions; exporting the mesh without them.` and the mesh exports without `targets` or `weights`.

The glTF mesh gets `weights` from the current `morphTargets.weights`: one per target, a missing entry as 0. Accessors are dense. Targets sharing arrays share accessors through the standard cache. The loader keeps no tangent deltas and no target names, so neither is emitted (see Scope).

#### Thin instances — `ext/export-ext-instancing.ts`

A mesh with `thinInstances` (`count > 0`) attaches `EXT_mesh_gpu_instancing` to its node.

- **Matrices.** `matrices` is a `Float32Array`, or a `Float64Array` under a high-precision-matrix engine (values are downcast to float32 on emission). Instance `i` is at offset `16·i`, column-major per module 21. Only the first `count` instances are read; the array may have spare capacity.
- **Decomposition.** Instance matrices are node-local in Lite (`finalWorld = world × instanceMatrix`), which matches the extension. Each matrix is decomposed with `decomposeMat4`, which returns `{ translation, rotation, scale }`.
- **Attributes.** `TRANSLATION` (VEC3/FLOAT), `ROTATION` (VEC4/FLOAT) and `SCALE` (VEC3/FLOAT), each tightly packed with no bufferView target and no min/max. Each is emitted only when some instance deviates from its identity value by more than 0.001 (detection tolerance): any translation component, any of the rotation's x, y, z, or any scale component's distance from 1. The extension requires at least one attribute, so when nothing else is written, `TRANSLATION` is written even for all-identity instances.
- **Conversion.** Converting passes convert instance translations and rotations with the static rules; scale passes through.
- **Mirrored instances.** A negative-determinant matrix decomposes to the canonical negative-Y-scale TRS (`decomposeMat4` folds the mirror into −Y). Mirrored instances therefore survive round trips canonically, but not sign-faithfully.
- **Colors.** `colors` (RGBA per instance, at least `4 × count` values) emits `attributes._COLOR_0` as VEC3/FLOAT, the Babylon.js convention for this attribute. Alpha is dropped; when some instance alpha is below 1, the exporter logs one warning per mesh: `Instance color alpha of mesh "<name>" is not represented in _COLOR_0; exporting RGB.` The glTF loader does not retain instance colors, so this applies to natively built instances.

The extension payload is `{ attributes }`. It is recorded in `extensionsUsed` only; it is optional by design.

---

### Material export — `export-materials.ts`, `export-material-slots.ts`

#### Dispatch

The exporter resolves `getMaterialSource(material)` first: a `MaterialView` only overrides render features, and props are read from its source. Materials dedupe by source identity and UV state through `materialIndex`. The family comes from `getMaterialFamily`:

| Family                            | Path                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `"pbr"`                           | PBR core mapping, then the writer sweep                                                                                                       |
| `"standard"`                      | Standard→metallic-roughness conversion                                                                                                        |
| `"node"`, `"shader"`, `undefined` | warning `Material "<name>" of family "<family>" is not mapped to glTF; exporting the primitive without a material.` (`unknown` for undefined) |

A mesh without a material also exports without `primitive.material`, silently. Every emitted material carries `name` and, last, `extras` when present. `pbrMetallicRoughness` is created first, so slot and factor members appear in capture order (see Determinism); a `pbrMetallicRoughness` that ends up with no members is removed after resolution. The writer sweep runs the fixed `MATERIAL_EXTENSION_WRITERS` order for PBR materials; each writer attaches its own extension, which records the name in `extensionsUsed`. Standard materials have no writer sweep.

`export-material-slots.ts` holds the helpers every material path shares: `capturePbrSlot(ctx, material, uvState, owner, req)` (one PBR slot: UV selection, mesh UV state, transform gate, then `captureTextureSlot`; `req` is a `PbrSlotRequest` `{ key, slot? (image name, defaults to key), texture, transform: boolean (the slot's gate), uv1?: boolean, extra? }`), `pbrCoreSlot` (a core-slot request from its `_uv2Mask` bit), `pbrUv1TexCoord`, `warnLostUv1`, `textureTransformOf`, `hasTx`, `isOneByOne`, `materialLabel`, `setUnlessDefault` / `setVecUnlessDefault` (exact-equality omission), and the `_uv2Mask` bit constants `UV2_BASE_COLOR` (1), `UV2_ORM` (2), `UV2_NORMAL` (4), `UV2_EMISSIVE` (8), `UV2_SPEC_GLOSS` (16) and `UV2_OCCLUSION` (32).

#### UV states

A slot that samples the second UV set needs `TEXCOORD_1` on every primitive that uses the material, or glTF-Validator rejects the file (`MESH_PRIMITIVE_TOO_FEW_TEXCOORDS`). Which UV set Lite samples can also depend on the mesh, so each primitive has a **UV state**:

| UV state | Mesh condition                                                                  | UV1-selected slots export as                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"uv1"`  | `TEXCOORD_1` exports (`_cpuUv2s` present, correct length)                       | `texCoord: 1`                                                                                                                                                                                                                                            |
| `"uv0"`  | no second UV set at all (no CPU array, no `_gpu.uv2Buffer`)                     | PBR: `texCoord: 0`, because the PBR shader samples UV0 when the mesh has no UV2 buffer. The exception is a UV1 `occlusionTexture`, which Lite then does not sample at all; it is not exported. Standard: omitted, because its shader does not fall back. |
| `"lost"` | a UV2 buffer on the GPU only, or a retained second UV array of the wrong length | omitted, with `Material "<name>" samples TEXCOORD_1 on a mesh whose second UV set is on the GPU only; exporting that mesh's material without its UV1 textures.`                                                                                          |

**UV1 selection.** A PBR material selects UV1 when `_uv2Mask & 63` is non-zero (bit 64, the lightmap, does not export), or an iridescence `texture` / `thicknessTexture` has `_texCoord === 1`. A Standard material selects UV1 when its diffuse texture has `diffuseCoordIndex === 1` or its ambient texture has `ambientCoordIndex === 1`.

`materialIndex` holds one glTF material per (source material, UV state) actually used. A material that does not select UV1 has a single glTF material shared by all three states.

#### Unset fields

Natively built materials leave most optional fields unset, and the renderer then applies its own defaults. These defaults can differ from glTF's. The exporter resolves every material field it reads as `field ?? runtimeDefault`, using the default the renderer applies (the `writeUbo` / feature code cited below), and only then applies the glTF omission rules:

| Field                                                                                       | Runtime default                    | Source                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| `occlusionStrength`                                                                         | 1                                  | `pbr-material-features.ts`   |
| `_clearCoat.intensity` / `.roughness` / `.bumpTextureScale` / `.indexOfRefraction`          | 1 / 0 / 1 / 1.5                    | `clearcoat-fragment.ts`      |
| `_clearCoat.useF0Remap`                                                                     | on (only `=== false` turns it off) | `clearcoat-fragment.ts`      |
| `_sheen.color` / `.intensity` / `.roughness`                                                | `[1,1,1]` / 1 / 0                  | `sheen-fragment.ts`          |
| `_iridescence.intensity` / `.indexOfRefraction` / `.minimumThickness` / `.maximumThickness` | 1 / 1.3 / 100 / 400                | `iridescence-fragment.ts`    |
| `_anisotropy.intensity` / `.direction`                                                      | 1 / `[1, 0]`                       | `anisotropy-fragment.ts`     |
| `_subsurface.refraction.intensity` / `.indexOfRefraction`                                   | 0 / 1.5                            | `refraction-rtt-fragment.ts` |
| `_subsurface.tint.color` / `.atDistance`                                                    | `[1,1,1]` / 1                      | `refraction-rtt-fragment.ts` |
| `_subsurface.translucency.intensity` / `.color`                                             | 1 / `[1,1,1]`                      | `subsurface-fragment.ts`     |
| `_subsurface.thickness.min` / `.max`                                                        | 0 / 1                              | `subsurface-fragment.ts`     |
| `_specularWeight`                                                                           | `_metallicF0Factor ?? 1`           | `reflectance-fragment.ts`    |
| `_metallicReflectanceColor`                                                                 | `[1,1,1]`                          | `reflectance-fragment.ts`    |
| `baseColorFactor` / `alpha`                                                                 | `[1,1,1,1]` / 1                    | `pbr-renderable.ts`          |
| `metallicFactor` / `roughnessFactor` / `normalTextureScale`                                 | 1 / 1 / 1                          | `pbr-renderable.ts`          |
| `reflectance`                                                                               | 0.04                               | `pbr-renderable.ts`          |

The loader always writes these fields explicitly, so loaded content round-trips unchanged; the defaults matter for natively built materials.

#### PBR core — `PbrMaterialProps` → glTF core material

The loader assembles `PbrMaterialProps` in glTF's own shape (`gltf-pbr-builder.ts`). The core path inverts it field by field, taking into account where the loader bakes factors into textures:

| glTF output                          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseColorTexture`                   | `baseColorTexture` through the texture funnel, unless it is 1×1: a 1×1 base color folds into the factor and emits no texture. The loader's factor bake is 1×1 (`rgba8unorm-srgb`, bytes `[linearToSrgbByte(rgb), 255]`; the factor's alpha lives only in `alpha` for BLEND and MASK materials); a genuine 1×1 image folds the same way (see "Bake grid" below).                                                                                                                                                                                                                                                              |
| `baseColorFactor`                    | Let `f = baseColorFactor ?? [1,1,1,1]` and `α = alpha ?? 1`; the shader computes `sample.rgb × f.rgb` and `sample.a × f.a × α`. Without a fold: `[f.rgb, f.a × α]`. With a fold of texel `t`: `[d(t.rgb) × f.rgb, t.a / 255 × f.a × α]`, with `t.a / 255` taken as 1 on an opaque material (no `alphaMode`), where the decode `d` follows the shader: `srgbByteToLinear` for an `-srgb` texture format, `(b / 255)^2.2` for a linear format on a `_gammaAlbedo` material, else `b / 255`; folded RGB then snaps to the bake grid. Clamped to [0, 1] with a warning when outside it. Omitted when within 1e-9 of `[1,1,1,1]`. |
| `metallicFactor` / `roughnessFactor` | Let `m = metallicFactor ?? 1` and `r = roughnessFactor ?? 1`; the shader multiplies them into `orm.b` and `orm.g`. Without an ORM fold, `m` and `r`. With a fold of texel `t`: `m × t.b / 255` and `r × t.g / 255`, snapped to the bake grid. Clamped to [0, 1] with a warning when outside it. Each omitted at exactly 1.                                                                                                                                                                                                                                                                                                   |
| `metallicRoughnessTexture`           | `ormTexture`, unless it folds or the material has a `specGlossTexture` (the spec-gloss shader path takes roughness and metallic from that texture instead, so its ORM is not examined for this slot or for a fold). Lite's ORM packing is glTF's (R occlusion, G roughness, B metallic). For occlusion-only sources the loader uses the occlusion image as `ormTexture`; it exports here too, because that is what Lite samples for roughness and metallic. See "1×1 ORM" below for the fold decision.                                                                                                                       |
| `occlusionTexture`                   | With `s = occlusionStrength ?? 1`: omitted when `s` is 0. Otherwise `occlusionTexture` when set and sampled (a separate UV1 occlusion image in the `"uv1"` state, or the loader's ORM carrier on UV0; see PBR slot mapping); else the unfolded `ormTexture`, sharing its image as glTF ORM assets do (this also holds for a material with a `specGlossTexture`, whose shader still reads occlusion from the ORM's R channel); else omitted. `strength` is `s` when ≠ 1 (the loader imports 1 or 0; glTF `strength` is not read at load). `texCoord` and the transform follow PBR slot mapping.                               |
| `normalTexture`                      | `normalTexture`; `scale` is `normalTextureScale` when ≠ 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `emissiveTexture`                    | `emissiveTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `emissiveFactor`                     | From `_emissiveColor` with `m = max(r, g, b)`. When `m ≤ 1`, the color itself; when `m > 1`, `_emissiveColor / m`, and the emissive-strength writer emits `{ emissiveStrength: m }`; this inverts the loader's premultiplication. Negative components clamp to 0 (no warning). Omitted when within 1e-9 of `[0,0,0]`. When `_emissiveColor` is unset and `emissiveTexture` is set, `[1,1,1]`, because the shader then applies the texture alone.                                                                                                                                                                             |
| `alphaMode` / `alphaCutoff`          | `_alphaCutOff > 0` → `"MASK"`, with the cutoff written when ≠ 0.5. Otherwise `alphaBlend === true` or `α < 1` → `"BLEND"`. Otherwise omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `doubleSided`                        | `doubleSided === true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Factor clamping.** glTF factors live in [0, 1]. Base color, metallic and roughness (and Standard emissive) that fall outside it are clamped, and the material logs `Material "<name>" has factors outside [0, 1], which glTF cannot represent; exporting them clamped.` The clamp applies to the final value, so a fold's product is clamped too.

**Folds.** A fold records the texture's GPU texture and the props' factors during capture, and reserves its factor members' JSON position (`undefined` until resolved). Its texel comes from the same readback as any image (4 bytes). When the texture is unreadable (`textureReadIssue` is non-null: null engine, non-2D, too large), no fold is recorded: the exporter logs `1×1 factor texture for material "<name>" is not readable on this engine; exporting its factors without the texture.` and writes the props' factors alone.

**1×1 ORM.** glTF has no occlusion factor, so a 1×1 `ormTexture` folds into the metallic and roughness factors only when occlusion does not need its R channel.

- Occlusion reads the ORM when `s ≠ 0` and no separate `occlusionTexture` is set. The exporter then captures the `metallicRoughnessTexture` and `occlusionTexture` slots as **fallback slots** on the fold, which share one mapping and image.
- At resolution, if the texel's R byte is 255, the fold applies and the fallback slots are cancelled (no image). Otherwise the plain factors are written and the fallback slots export the 1×1 image.
- When occlusion does not read the ORM, the fold applies without fallback slots. The loader's bake is `[255, rough, metal, 255]`, so it always folds.

**Bake grid.** On reload the loader bakes a factor-only base color into a 1×1 `rgba8unorm-srgb` texel and factor-only metallic and roughness into a 1×1 ORM, which moves any factor off its 8-bit grid by up to half a step. A folded factor off that grid would therefore change on the next export: a genuine white 1×1 image with factor 0.5 would export 0.5, reload as byte 188 and re-export ≈0.50289. Resolution snaps each folded value in [0, 1] to what its bake decodes back to: `srgbByteToLinear(linearToSrgbByte(v))` for base color RGB, `round(v × 255) / 255` for metallic and roughness. The loader's own bakes are already on the grid and are unchanged. A genuine 1×1 image moves by at most half a step, which is what a reload renders anyway. Out-of-range values are not snapped, so the clamp still warns. Fold alpha is not snapped: BLEND and MASK reloads keep it exactly in `alpha`. On an opaque material Lite never reads the alpha and the loader drops it, so a texel alpha below 255 does not fold there.

These rules export what Lite renders. For loaded BLEND and MASK materials the loader keeps the factor's alpha only in `alpha` and stores `baseColorFactor` with alpha 1 (`getGltfBaseColorRgbFactor`, `gltf-pbr-builder.ts`), so the source alpha round-trips exactly.

#### PBR slot mapping

Lite's PBR shader decides each slot's UV set and transform with different gates for core and extension slots. The exporter reads exactly what the shader reads; `getTextureCoordinateIndex` is not used.

| Slot kind                                                                                                                                                                      | `texCoord`                                                                                                                   | Transform                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Core: `baseColorTexture`, `ormTexture` (exported as `metallicRoughnessTexture`, and as `occlusionTexture` when shared), `normalTexture`, `emissiveTexture`, `specGlossTexture` | UV1-selected when the slot's `_uv2Mask` bit is set (base color 1, ORM 2, normal 4, emissive 8, spec-gloss 16); see UV states | `getTextureTransform(tex)` when `material._hasUvTx`; else none         |
| Separate `occlusionTexture` with `_uv2Mask` bit 32 (UV1 occlusion; the loader sets the bit from `occlusionTexCoord === 1`)                                                     | `"uv1"` state: 1. `"uv0"` state: Lite does not sample it, so it is not exported. `"lost"`: omitted with the warning          | none: the shader samples raw `input.uv2` (`pbr-template-ext.ts`)       |
| Separate `occlusionTexture` on UV0 (the loader's ORM carrier, sampled as `ormTexture` at the occlusion's own UV)                                                               | 0                                                                                                                            | as core, from the `occlusionTexture` wrapper                           |
| Extension slots                                                                                                                                                                | UV0, except iridescence textures with `_texCoord === 1`, which are UV1-selected                                              | `getTextureTransform(tex)` when the slot's gate below is on; else none |

Each extension fragment gates its UV transform differently; the exporter mirrors each gate exactly:

| Extension slots                                                | Transform applied when                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| clearcoat `texture` / `roughnessTexture` / `bumpTexture`       | any of the three has `_hasTx` (`clearcoat-fragment.ts`)                       |
| sheen `texture`                                                | it has `_hasTx`                                                               |
| sheen `roughnessTexture`                                       | always                                                                        |
| iridescence `texture` / `thicknessTexture`                     | each by its own `_hasTx`                                                      |
| anisotropy `texture`                                           | always                                                                        |
| specular `_metallicReflectanceTexture` / `_reflectanceTexture` | either has `_hasTx` (`reflectance-fragment.ts`)                               |
| transmission `refraction.texture`                              | always                                                                        |
| volume `thickness.texture`                                     | always on the refraction path (`_transmissive`); never on the subsurface path |
| diffuse transmission `intensityTexture` / `colorTexture`       | either has `_hasTx` (`subsurface-fragment.ts`)                                |

"Always" matters when an application sets `uScale`, `uAng` or the other transform fields directly, without `_hasTx`: they are public mutable fields. PBR slots always use storage row order and no channel inversion.

#### Standard material → metallic-roughness

The Babylon.js Blinn-Phong conversion. Standard colors are gamma-space (the Standard shader uses `diffuseColor` raw), and Lite decodes them with the 2.2 power form used by the Babylon.js default path. Missing fields resolve to `alpha 1`, `diffuseColor [1,1,1]`, `emissiveColor [0,0,0]`, `specularPower 64`, `uvScale [1,1]`, `uvOffset [0,0]`, `bumpLevel 1`, `diffuseCoordIndex 0` and `ambientCoordIndex 0`.

```
baseColorFactor = [linear(diffuseColor) × 0.5, alpha]      linear(c) = c^2.2 per channel
metallicFactor  = 0
roughnessFactor = SpecularPowerToRoughness(clamp(specularPower, 0, 1024))
    where t = (P / 1300)^0.333333
          roughness = CubicBezier(t; 1.0, 0.1, 0.1, 0.1)
          CubicBezier(t; p0,p1,p2,p3) = (1−t)³p0 + 3(1−t)²t·p1 + 3(1−t)t²·p2 + t³p3
```

`metallicFactor` is always written (as 0). `roughnessFactor` is omitted at 1. The base color factor is clamped to [0, 1] with the factor warning.

Texture and flag mapping:

- `diffuseTexture` → `baseColorTexture`, with `texCoord` from `diffuseCoordIndex`.
- `_bumpTexture` → `normalTexture`, with `scale = bumpLevel` when ≠ 1, and channel inversion:
    - **Scale.** Lite's Standard shader writes `1 / bumpLevel` to its UBO and multiplies the surface normal by it before building the cotangent frame (`perturbNormal` in `shader/wgsl-helpers.ts`). The frame's tangent and bitangent are renormalized, so the perturbed normal is `normalize(T·x + B·y + N·z / bumpLevel)`, which equals glTF's `normalize(T·x·s + B·y·s + N·z)` with `s = bumpLevel`. Babylon.js writes `level` the same way. `.babylon` sources copy Babylon.js's `level` into `bumpLevel` verbatim.
    - **Frame.** `perturbNormal` negates both screen-space `dpdy` terms, so its frame is `(−T₀, −B₀)`, where `T₀`, `B₀` come from the plain derivative formula. The PBR cotangent frame that renders the reimported glTF (`pbr-template.ts`) is `(T₀, −B₀)`. The tangent therefore points the other way. A flipped bump slot (see Standard UV mapping) also negates the derivative of the V coordinate that `perturbNormal` sees, relative to the exported UVs.
    - **Inversion.** The exported normal image inverts its red channel (`r → 255 − r`), and also its green channel when the bump slot is flipped: `invert: "r"` or `"rg"` in its `SlotMapping`.
- `_emissiveTexture` → `emissiveTexture`, with `emissiveFactor` preset to `[1,1,1]`. A non-black `emissiveColor` overwrites `emissiveFactor`, converted gamma → linear (`c^2.2`), because the Standard shader adds it in gamma space, and clamped to [0, 1] with the factor warning. Babylon.js writes it unconverted.
- `_ambientTexture` → `occlusionTexture`, with `texCoord` from `ambientCoordIndex`.
- `backFaceCulling === false` → `doubleSided: true`.

**Unlit (`disableLighting === true`).** The unlit Standard shader outputs `clamp(emissive × diffuse)` times the diffuse texture, in gamma space. The conversion differs from the lit one:

- `baseColorFactor = [linear(clamp(emissiveColor × diffuseColor, 0, 1)), alpha]`, with no 0.5 factor, and neither `metallicFactor` nor `roughnessFactor` is written.
- `KHR_materials_unlit` is attached directly (Standard materials do not run the writer sweep).
- Only the diffuse texture exports. The normal, ambient and emissive textures and the emissive factor are skipped, and an emissive texture logs `Material "<name>" is unlit with an emissive texture, which KHR_materials_unlit cannot represent; exporting it without the texture.`

**Alpha.** Lite's alpha test runs only on the diffuse texture's alpha, and its output alpha is the material alpha (times an opacity texture). Let `blends = alpha < 1 || _opacityTexture`.

- `alphaCutOff > 0` with a diffuse texture and not `blends` → `"MASK"`, with the cutoff written when ≠ 0.5.
- `blends` → `"BLEND"`. If the material also has a cutoff and a diffuse texture, it logs `Material "<name>" both alpha-tests and blends, which glTF cannot represent; exporting it as BLEND.`
- A cutoff without a diffuse texture is ignored.

#### Standard UV mapping and row order

The Standard shader samples each slot through an affine UV map and an optional V-flip, and it has two render paths. The exporter reproduces both exactly: it reads a **flipped** slot's image with reversed rows, and it emits the `KHR_texture_transform` `T` that maps glTF UVs onto rows of that PNG.

A reversed-row PNG has row coordinate `t = 1 − v_s`, where `v_s` is the storage coordinate Lite samples. So for a flipped slot `T_v = 1 − v_s(uv)`, and for an unflipped slot `T_v = v_s(uv)`. `T_u` is always Lite's `u_s(uv)`.

Let `S = uvScale` and `O = uvOffset ?? [0, 0]` on both paths. A slot is UV1-selected when its material coord index is 1 (`diffuseCoordIndex`, `ambientCoordIndex`, …), regardless of the mesh; see UV states.

- **Shared path** (`material._hasUvTx` unset; `standard-pipeline.ts`):
    - UV0 slots (diffuse, emissive, bump, opacity, UV0 ambient) share one varying. Unflipped, `v_s = S_y·v + O_y`. Flipped, the shader applies the flip before the transform, so `v_s = S_y·(1 − v) + O_y`. In both cases `u_s = S_x·u + O_x`.
    - All UV0 slots are flipped when the material-wide orientation is inverted. That orientation is `isStandardUvInverted`: the diffuse texture's `invertY`, else the opacity texture's, else the bump texture's.
    - Emitted `T`: `scale = [S_x, S_y]`. `offset = [O_x, O_y]` when unflipped, and `[O_x, 1 − S_y − O_y]` when flipped.
    - UV1 slots sample `uv` directly, are never flipped, and emit no transform.
- **Per-texture path** (`material._hasUvTx === true`; `std-uv-transform-fragment.ts`):
    - Every slot has the affine map `A(uv) = M·(S·uv + O) + [uOffset, vOffset]` for UV0 slots, and `A(uv) = M·uv + [uOffset, vOffset]` for UV1 slots. Here `M = [[c·sx, s·sy], [−s·sx, c·sy]]`, `c, s = cos, sin(uAng)`, and `sx, sy = uScale, vScale`.
    - Unflipped, `(u_s, v_s) = A(uv)`. Flipped, the shader applies the flip after the transform: `u_s = A_u(uv)` and `v_s = 1 − A_v(uv)`. So in both cases `T = A`.
    - Each slot is flipped when its own texture has `invertY === true`.
    - `A` is a rotation by `uAng`, then a scale, then an offset, which is exactly `KHR_texture_transform`. Its rotation maps `u′ = c·u + s·v`, `v′ = −s·u + c·v`, as glTF-Sample-Renderer, three.js and Babylon.js apply it and as the extension's lower-left-quadrant example requires. It emits as `rotation = uAng`; `scale = [sx·S_x, sy·S_y]` (UV0) or `[sx, sy]` (UV1); and `offset = M·O + [uOffset, vOffset]` (UV0) or `[uOffset, vOffset]` (UV1).

Components equal to their defaults are omitted.

On the shared path the renderer honors `uvOffset` only after `enableStandardUvOffset()`, and whether that ran is private to `standard-pipeline.ts`. The exporter always applies `uvOffset` (see Scope), so a material that sets it without the opt-in exports an offset that Lite did not render.

#### Extension writer digests

Each writer inverts the corresponding loader module. Triggers and default omissions mirror the loader's import defaults, so round trips converge.

| Writer                 | Trigger                                                                                                                                                       | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlit`                | `_unlit === true` (PBR path; the Standard path attaches the extension itself)                                                                                 | `KHR_materials_unlit = {}`. The unlit fragment computes `color = baseColor × _unlitColor`, and the loader never sets `_unlitColor`. When `_unlitColor` is set and not all ones, an `afterResolve` callback multiplies the resolved core `baseColorFactor` rgb by it (default factor `[1,1,1,1]`, alpha untouched), clamps to [0, 1], and drops the factor when the result is all ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `emissive-strength`    | `max(_emissiveColor) > 1`                                                                                                                                     | `{ emissiveStrength: m }`, with the core factor normalized to peak 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `clearcoat`            | `_clearCoat?.isEnabled`                                                                                                                                       | `clearcoatFactor` = `intensity ?? 1` (omitted at 0). The loader imports a texture without a factor as intensity 1, so that state re-exports as an explicit factor 1. `clearcoatRoughnessFactor` = `roughness ?? 0` (omitted at 0). `clearcoatTexture` = `texture`, `clearcoatRoughnessTexture` = `roughnessTexture`, `clearcoatNormalTexture` = `bumpTexture` with `scale = bumpTextureScale` when ≠ 1. An `indexOfRefraction ≠ 1.5` and an F0 remap that is on (`useF0Remap !== false`; the runtime default is on, and the loader sets `false`) are outside this extension's schema; each logs a warning and the rest still exports.                                                                                                                                                                                                                                                    |
| `sheen`                | `_sheen?.isEnabled`                                                                                                                                           | `sheenColorFactor` = `(color ?? [1,1,1]) × (intensity ?? 1)`, omitted at `[0,0,0]`; the loader imports with `intensity = 1`, so glTF-sourced materials round-trip exactly. `sheenRoughnessFactor` = `roughness` (omitted at 0). `sheenColorTexture` = `texture`. `sheenRoughnessTexture` = `roughnessTexture` when set, else `texture` when set: Lite reads packed sheen roughness from the color texture's alpha whenever no roughness texture exists, and re-referencing the texture preserves that on reimport. `albedoScaling` has no glTF field; it only selects how a linear-format color texture converts to sRGB (gamma power when disabled; see Color encoding).                                                                                                                                                                                                                |
| `iridescence`          | `_iridescence?.isEnabled`                                                                                                                                     | `iridescenceFactor` = `intensity ?? 1` (omitted at 0), `iridescenceIor` = `indexOfRefraction` (omitted at 1.3), `iridescenceThicknessMinimum` / `Maximum` = `minimumThickness` / `maximumThickness` (omitted at 100 / 400; already in nanometres), `iridescenceTexture`, `iridescenceThicknessTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `anisotropy`           | `_anisotropy?.isEnabled`                                                                                                                                      | `anisotropyStrength` = `intensity ?? 1` (omitted at 0). `anisotropyRotation` = `atan2(d[1], d[0])` with `d = direction ?? [1, 0]` (omitted at 0), which inverts the loader's `direction = [cos rot, sin rot]`. `anisotropyTexture` = `texture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ior`                  | `_subsurface?.refraction?.indexOfRefraction` set, or `reflectance` set to a value other than 0.04 on a material without a `specGlossTexture`                  | `{ ior }`, written when it differs from 1.5 by more than 1e-9. The refraction IOR wins. Otherwise Lite's dielectric F0 is `reflectance`, and the equivalent IOR is `(1 + r) / (1 − r)` with `r = √clamp(reflectance, 0, 0.99)`, so that `F0 = ((ior − 1) / (ior + 1))²`. Spec-gloss materials take F0 from their texture, so `reflectance` is ignored for them. The loader also creates `refraction` for an explicit 1.5; emitting nothing is equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `specular`             | any of: weight `w = _specularWeight ?? _metallicF0Factor ?? 1` ≠ 1, `_metallicReflectanceColor` ≠ white, `_metallicReflectanceTexture`, `_reflectanceTexture` | `specularFactor` = `w` when ≠ 1; `specularColorFactor` = `_metallicReflectanceColor` when ≠ white; `specularTexture` = `_metallicReflectanceTexture`; `specularColorTexture` = `_reflectanceTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `transmission`         | `_transmissive === true`                                                                                                                                      | `transmissionFactor` = `_subsurface.refraction.intensity` (omitted at 0), `transmissionTexture` = `_subsurface.refraction.texture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `volume`               | `_subsurface?.thickness?.useGlTFChannel === true`, or `_subsurface?.tint` set with no `thickness` (an attenuation-only source volume)                         | `thicknessFactor` = `thickness.max ?? 1` when `thickness` is present (omitted at 0), `thicknessTexture` = `thickness.texture`, and, unless the tint is the synthesized no-absorption tint, `attenuationDistance` = `tint.atDistance ?? 1` (the runtime default) when > 0 and `attenuationColor` = `tint.color` when ≠ white. The loader's synthesized no-absorption tint (color unset or within 1e-6 of white, with distance 1) emits no attenuation fields, restoring the source's omitted form. (The loader substitutes 1 for an absent or zero `thicknessFactor`, so that state re-exports as 1.)                                                                                                                                                                                                                                                                                     |
| `dispersion`           | `_subsurface?.refraction?.dispersion > 0`, with refraction and thickness present                                                                              | `{ dispersion: 20 / refraction.dispersion }`, the inverse of the loader's `20 / dispersion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `diffuse-transmission` | `_subsurface?.translucency` with `thickness.min === 0 && thickness.max === 0` (the loader's thin-surface marker)                                              | `diffuseTransmissionFactor` = `intensity ?? 1` (omitted at 0), `diffuseTransmissionTexture` = `intensityTexture`, `diffuseTransmissionColorFactor` = `color` when ≠ white, `diffuseTransmissionColorTexture` = `colorTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `spec-gloss`           | `specGlossTexture` set                                                                                                                                        | `KHR_materials_pbrSpecularGlossiness` with: `diffuseTexture` = `baseColorTexture` (UV-selected by `_uv2Mask` bit 1), omitted when the texture is 1×1 and folded into the factor; `specularGlossinessTexture` = `specGlossTexture` (bit 16); `diffuseFactor` = the resolved core `baseColorFactor` when it is emitted, written by an `afterResolve` callback. `specularFactor` and `glossinessFactor` are omitted: with a spec-gloss texture, Lite's shader takes F0 from the texture's RGB and roughness from `1 − A`, and ignores both factors. The core path exports no `metallicRoughnessTexture` for this material, never examines or folds its ORM, and keeps the core factors (`metallicFactor`, `roughnessFactor`) as the fallback for readers without the extension. Occlusion still exports from `ormTexture`, because the spec-gloss shader reads it from the ORM's R channel. |

The specular weight is read exactly as the shader reads it. The loader's IOR path parks a normalized IOR-derived F0 in `_metallicF0Factor` but sets `_specularWeight = 1`, so an IOR-only material has `w = 1` and emits no `specularFactor`. Its specular path writes the specular factor to both fields, or deletes both when the factor is ≈ 1.

Loader losses the exporter cannot undo, listed so round-trip tests expect them:

- `diffuseFactor`, `specularFactor` and `glossinessFactor` on spec-gloss sources with a texture: the loader drops `diffuseFactor`, and the shader ignores the other two.
- `innerConeAngle` on lights.
- Light names: the loader does not retain them, so a loaded light exports unnamed; native light names export.
- A diffuse-transmission layer on materials that also carry IOR, transmission or volume. The loader merges extension layers with a shallow `Object.assign`, so the dielectric `_subsurface` replaces the translucency one.
- glTF `occlusionTexture.strength`.

---

### Texture export — `export-textures.ts`

```typescript
/** Capture one material slot (synchronous). Records a PendingSlot and submits the texture's
 *  readback unless one is already in flight. An unreadable texture logs its warning and records
 *  nothing (returns null). Writes nothing to `owner` except reserving the member's JSON position;
 *  resolution writes the textureInfo. */
function captureTextureSlot(
    ctx: ExportContext,
    owner: GltfJsonObject,
    key: string,
    slot: string,
    tex: Texture2D,
    mapping: SlotMapping,
    materialName: string,
    extra?: Readonly<Record<string, number>>
): PendingSlot | null;

/** Resolve every captured slot, in capture order, after all readbacks have settled (synchronous). */
function resolveTextureSlots(ctx: ExportContext): void;
```

The material modules call `captureTextureSlot` for every slot, with the `SlotMapping` that PBR slot mapping or Standard UV mapping produces. Capture checks that the texture can be read back (see Images) and, when it can, submits the readback and sets `owner[key] = undefined` so the member's JSON position follows capture order; an unresolved slot stays `undefined`, which `JSON.stringify` omits. Resolution, per pending slot in capture order:

- **Skip** a slot that fold resolution cancelled, or whose pixels are null.
- **Image.** The slot takes its texture's `PixelData`, applies `mapping.rowOrder` and `mapping.invert`, and inserts or reuses an image by content (see Images).
- **Texture.** One glTF texture per image (`textureIndex`), with no `sampler` (see Samplers).
- **TextureInfo.** `owner[key]` is set to `{ index, texCoord?, ...extra, extensions? }`. It carries `texCoord` when it is 1, and `KHR_texture_transform` built from `mapping.transform`. Two slots that reference one image with different transforms emit two textureInfos over one texture.

#### `ext/export-ext-texture-transform.ts` — KHR_texture_transform

This inverts `gltf-ext-uv-transform.ts`, which copies glTF values onto the wrapper verbatim. For PBR slots the values come from `getTextureTransform(tex)`, gated as PBR slot mapping says; for Standard slots, from the Standard mapping:

| Output     | PBR source            | Written when                                 |
| ---------- | --------------------- | -------------------------------------------- |
| `offset`   | `[uOffset, vOffset]`  | either ≠ 0                                   |
| `scale`    | `[uScale, vScale]`    | either ≠ 1                                   |
| `rotation` | `uAng`                | ≠ 0                                          |
| `texCoord` | the slot's `texCoord` | ≠ 0 (only when another component is written) |

Components compare exactly against their defaults (no tolerance). When no component is present, no extension object is written. Writing one records `KHR_texture_transform` in `extensionsUsed` (optional extension).

`uAng` holds the glTF `rotation` angle verbatim: the loader copies it with no sign change on import, and export re-emits it unchanged. (Babylon.js stores the opposite sign in `wAng` and its serializer negates it on export; Lite's storage convention makes re-emission sign-neutral.)

#### Samplers

No `samplers` array and no `texture.sampler` are emitted (see Scope). Readers then apply glTF's default sampling: repeat wrapping in both directions, with filtering chosen by the implementation. Lite's loader imports that as its shared linear / linear / linear, repeat / repeat sampler. Clamp, mirror and nearest sampling therefore do not survive export. There is no warning, because `GPUSampler` settings cannot be read back to detect them.

---

### Image export — `export-images.ts`, `export-png.ts`

Each captured slot gets its image from the first of these sources that applies:

1. **Factor fold.** Base color and ORM only; see PBR core. No image is emitted.
2. **Readback.** The texture's GPU pixels, encoded as PNG.

Original encoded bytes are never re-embedded: the loader keeps none (see Scope).

#### Readback

The exporter submits readbacks during capture, one per distinct `GPUTexture`, at the first slot or fold that needs one, and stores the promise in `pixelCache`. The promise never rejects: a failure is recorded in `readbackErrors` (at the readback's submission position) and the promise resolves to null, so a failure never surfaces as an unhandled rejection. The settle step reports it (State Machine). The procedure produces pixels in storage row order:

1. **Preconditions.** `textureReadIssue(ctx, tex)` returns the reason a texture cannot be read, or null. Slots whose texture cannot be read are omitted, each with its own warning:
    - `"engine"`: no `engine._device` (null engine), no GPU texture, or neither readback path below applies. Warning: `Texture pixels for material "<name>" are not readable on this engine; exporting the material without that texture.`
    - `"dimension"`: `dimension !== "2d"`, `depthOrArrayLayers > 1`, or `sampleCount > 1`. Warning: `Texture for material "<name>" is not a single-sampled 2D image; exporting the material without that texture.`
    - `"size"`: the padded staging buffer (`align(width × 4, 256) × height`) exceeds `device.limits.maxBufferSize` (when the device reports one). Warning: `Texture for material "<name>" is too large to read back on this device; exporting the material without that texture.`
2. **Direct copy.** If the format is `rgba8unorm`, `rgba8unorm-srgb`, `bgra8unorm` or `bgra8unorm-srgb` and `usage` includes `COPY_SRC`, copy mip 0 directly. glTF-loader raster images qualify: they are uploaded with `COPY_SRC`, unflipped, with `premultipliedAlpha: false` and `colorSpaceConversion: "none"`.
3. **Decode blit.** Otherwise, if `usage` includes `TEXTURE_BINDING` and the format is float-sampleable (not `depth*`, `stencil*`, `*sint` or `*uint`), blit mip 0 into a transient RGBA8 target of the same size (see Pipeline Configuration and Shader Logic), then copy the target. This covers textures created without `COPY_SRC`, and float and block-compressed formats. Textures without `COPY_SRC` include `loadTexture2D`, solid textures, and KTX2 (also when it comes from glTF `KHR_texture_basisu`). A format that fits neither path is `"engine"`.
4. **Copy and map.** `copyTextureToBuffer` into a `MAP_READ | COPY_DST` staging buffer with `bytesPerRow = align(width × 4, 256)`, submit, then `mapAsync(0x0001)`. The map mode is the literal `GPUMapMode.READ`, so the module never dereferences the WebGPU global namespace. A failure while encoding or submitting destroys the staging buffer and target created so far and is recorded as a readback error like an asynchronous one.
5. **Repack and release.** Repack rows tight into an RGBA8 `PixelData`. For a direct copy of a `bgra8*` source, swap B and R; the decode blit already writes RGBA. The staging buffer and any transient target are destroyed in a `finally`.

**Row order and channel ops.** Each slot asks for `"storage"` or `"reversed"` rows (`SlotMapping.rowOrder`). In `"reversed"` order, row `r` of the image is storage row `height − 1 − r`. `invert` then applies `v → 255 − v` to the named channels. With the slot's texCoord and transform, this reproduces what Lite samples:

- glTF-loaded images (uploaded unflipped, with glTF V-down UVs) come back byte-faithful and upright in storage order.
- Raster textures uploaded with the default flip (`loadTexture2D` with `invertY = true`, on Lite's Y-up UVs) produce a vertically mirrored PNG in storage order, which samples identically under the exported UVs.
- PBR slots always use storage order. Standard slots follow "Standard UV mapping and row order" (Materials).

**Factor folds.** A 1×1 `baseColorTexture` or `ormTexture` that folds (PBR core) is read from the 4 bytes of its `PixelData` and produces no image. Any other 1×1 texture exports as a normal image.

**Color encoding.** PBR color slots backed by linear-format textures convert RGB to glTF's sRGB image representation with `linearToSrgbByte`. A 256-entry lookup table per converted image bounds transfer-curve evaluation independently of image size. Base color and spec-gloss diffuse first apply `pow(rgb, 2.2)` when `_gammaAlbedo` is set. Emissive, spec-gloss specular RGB and diffuse-transmission color use their sampled linear RGB directly. Sheen color applies the gamma power only when `albedoScaling` is disabled. Alpha and data slots are unchanged. Textures already stored in an sRGB format retain their bytes. The reflectance writer retains the loader's existing gamma-byte convention; see Open conformance notes.

**Content dedup.** Readback images dedupe by content in their emitted form. The key includes dimensions, row order, channel inversion, color conversion and FNV-1a of the emitted bytes. On a key match the bytes are compared, and a mismatch takes a fresh image. A new image keeps its emitted RGBA bytes (`ctx.imagePixels`) until encoding. Separate sources with identical emitted bytes and operations share one image.

**HDR clamp.** Float sources (`rgba16float`, `rgba32float`, any format ending in `float`) are clamped to [0, 1] by the blit, with `Texture for material "<name>" has a floating-point format; exporting it clamped to 8 bits.` The warning comes from the slot check, not from folds.

**Shared sources.** Slot resolution caches image indices by GPU texture, row order, channel inversion and color conversion before content hashing. UV selection and transforms remain on individual textureInfos. Different GPU textures still use content deduplication.

**GLB placement.** Images are written as `{ name, mimeType: "image/png", bufferView }`, with `name` set to the glTF slot string through which the image was first exported (`"baseColorTexture"`, `"clearcoatTexture"`, …). `encodeImages` encodes and appends one PNG at a time in image-index order, bounding encoder scratch space to one image. BufferBuilder's source-identity cache uses weak keys; its copied payloads own the output bytes.

**PNG encoding** (`export-png.ts`) is dependency-free and worker-safe (no canvas, no DOM):

- The 8-byte signature.
- `IHDR`: width, height, bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0.
- One `IDAT`: the zlib stream of all scanlines, each prefixed with filter byte 0, produced by `new CompressionStream("deflate")` (the Compression Streams "deflate" format is the RFC 1950 zlib wrapper PNG requires).
- `IEND`.
- Chunk CRCs are CRC-32 (polynomial `0xEDB88320`), using a table built lazily on first use.

---

### Camera export — `export-cameras.ts`

`scene.camera`, when set, emits one `cameras[0]` entry plus a node reference. `cameras[0].name` is `camera.name` when non-empty. glTF-sourced cameras exist only when the asset was loaded with `enableGltfCameras()`; the loader names them from the camera definition, or `camera<i>`. The camera exports after the node sweep, so it can find its parent's node in `nodeIndex`.

**Node placement.**

`cameraFixupOf(camera)` finds the camera's **fixup** before the sweep. A camera's parent `F` is **fixup-shaped** when it is an exportable node that is not a mesh, has empty `children`, and has `scaling ≈ (−a, a, a)` for a uniform `a > 0` (`y > 0`). This is the scaffolding `gltf-feature-camera.ts` inserts (named `<camera>_fixup`; detection is by shape only). The loader sizes `a = 1/worldScale` to cancel inherited uniform scale. A fixup-shaped node never exports. The camera's **placement parent** `P` is:

- `F.parent`, when the camera has a fixup and that parent exported through another seed (it is in `nodeIndex`); otherwise none;
- `camera.parent` when it has no fixup and that parent exported (is in `nodeIndex`); otherwise none. A camera whose parent is foreign or unexported therefore exports as a parentless camera.

- **Pristine collapse.** When `F` exists, `P` exists, `F` has `position ≈ (0,0,0)` and `rotationQuaternion ≈ identity`, and the camera's transform relative to `F` (`world(F)⁻¹ · worldMatrix`) is ≈ the 180° yaw that `createFreeCamera((0,0,0), (0,0,−1))` leaves (rotation `diag(−1, 1, −1)`, zero translation): `node.camera` is written onto `P`'s exported node, with no other change to that node. The camera is recorded in `nodeIndex` and `nodeConvert` against that node. This is the exact inverse of the import, so pristine round trips are stable.
- **Residual fixup.** When `F` and `P` exist but the pristine conditions fail, the exporter logs `Camera fixup node "<F.name>" carries extra transform; exporting the camera as its own node.` and applies own-node placement under `P`. No transform is ever folded into `P`, because it is a source node that other content may reference. When `F` exists but `P` does not, own-node placement applies as a scene root, without a warning.
- **Own node.** Otherwise the camera becomes its own node, as a child of `P`'s exported node, or as a scene root when there is no `P`. Let `R = multiplyMat4(invertMat4(world(P)), camera.worldMatrix)`, or `camera.worldMatrix` with no `P`. `world(P)` is `P.worldMatrix`, a lazy getter that is valid before `registerScene`. A singular `world(P)` logs `Camera parent "<name>" has a singular world matrix; exporting the camera as a scene root.` and drops `P`. The node has `name` (the camera's, when non-empty), then `rotation` and `translation` (each omitted at identity or within 1e-9 of zero), then `camera`. Camera nodes never emit `scale`. The pass kind is `P`'s (`nodeConvert`), or converting with no `P`.
    - **Converting `P`, or no `P`.** `(t, q, s) = decomposeMat4(R)`. Emit `translation = (−t.x, t.y, t.z)` and `rotation = Rotate180Y(convert(q))`, where `convert` is the static quaternion rule. Lite cameras look along local +Z; glTF cameras look along −Z.
    - **Pass-through `P`.** Here `R` is expressed in `P`'s right-handed frame. `world(P)` includes the root flip (`det < 0`), while a camera that renders unmirrored in Lite has `det(camera.worldMatrix) > 0`, so `det(R) < 0`. Let `M` be `R` with its third column negated (`R · diag(1,1,−1)`). `(t, q, s) = decomposeMat4(M)`; emit `translation = t` and `rotation = q`, verbatim. When `det(R) > 0`, the camera's Lite view is mirrored relative to its parent, which glTF cannot represent: the exporter logs `Camera "<name>" has a mirrored view under its parent; exporting it unmirrored.` and emits the same decomposition (`decomposeMat4` folds the mirror into scale, which is dropped). For the pristine shape, `R = diag(a, a, −a)` gives `M = a·I`: identity rotation, zero translation, matching the collapse.

**Projection.**

| Case                 | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `camera.ortho` unset | `type: "perspective"`, `perspective: { yfov: fov, znear: nearPlane, zfar?, aspectRatio? }`. `zfar` is written only when `nearPlane < farPlane < 1e6`, restoring the glTF infinite form behind the loader's `1e6` sentinel. `aspectRatio` = `getEffectiveAspectRatio(camera, canvas.width, canvas.height)` with `canvas = scene.surface.canvas`; written only when there is a canvas with width and height above 0 and the ratio is finite and positive.                                                                                                                                                                                                                                                                                                                                    |
| `camera.ortho` set   | `type: "orthographic"`, `orthographic: { xmag, ymag, znear: nearPlane, zfar: farPlane }`. `xmag` = `(right − left) / 2` when both planes are non-null, else `halfHeight × aspectRatio`. `ymag` = `(top − bottom) / 2` when both are non-null, else `halfHeight`. The loader sets all four planes, so imported cameras always take the plane form. Without an aspect ratio (null engine, no canvas) the `halfHeight` fallback has no aspect source: `xmag = ymag`, with `Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.` glTF orthographic projections are symmetric: when `left + right` or `top + bottom` differs from 0 by more than ε, the exporter logs `Orthographic camera "<name>" has off-center bounds; exporting a symmetric projection.` |

---

### Light export — `ext/export-ext-lights-punctual.ts`

Each `scene.lights` entry with `lightType` `"point"`, `"directional"` or `"spot"` emits a `KHR_lights_punctual` light. `"hemispheric"` has no punctual counterpart; it logs `Hemispheric light is not representable in KHR_lights_punctual; skipping.` and contributes nothing. Any other `lightType` logs `Light type "<type>" is not exported.` Lights export after the camera.

**Light block.** Defaults are omitted, matching the extension schema and the loader's import defaults:

| Field                 | Source                                                                          | Written when                                         |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `name`                | `name`                                                                          | non-empty (the loader leaves glTF light names empty) |
| `type`                | `lightType`                                                                     | always                                               |
| `color`               | `diffuse`, negatives clamped to 0, divided by its peak when the peak is above 1 | ≠ `[1,1,1]`                                          |
| `intensity`           | `intensity`, multiplied by that peak                                            | ≠ 1                                                  |
| `range`               | `range` (point, spot only)                                                      | finite, above 0 and ≠ `Number.MAX_VALUE`             |
| `spot`                | spot lights only                                                                | always (an object, possibly empty)                   |
| `spot.outerConeAngle` | `angle / 2` (Lite stores the full cone angle), clamped to `[1e-4, π/2]`         | differs from π/4 by more than 1e-9                   |

glTF light colors live in [0, 1], so a brighter Lite color moves its peak into the intensity. A spot half-angle above π/2 clamps to π/2 and logs `Spot light "<name>" has a cone wider than KHR_lights_punctual allows; exporting a 180° cone.`; one below 1e-4 (or not a number) clamps to 1e-4 and logs `Spot light "<name>" has an empty cone; exporting the narrowest cone KHR_lights_punctual allows.` The lower bound exists because glTF requires the outer angle to exceed the inner angle (0). A spot `exponent` ≠ 1 logs `Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.` and export proceeds. `spot.innerConeAngle` is left at its schema default, the same resolution the loader applies on import.

**Node placement** inverts the loader, which parents each light to its glTF node with `position (0,0,0)` and `direction (0,0,−1)`. Local placement needs the light's parent to be an ordinary exported node (a camera's or another light's glTF node has a different frame from the Lite object).

- **Collapse.** The light attaches directly to its parent's exported node (`node.extensions.KHR_lights_punctual.light = i`) when that node holds no light yet, and the light's local state is identity-like, each test within 1e-9: `position` is `(0,0,0)`, `rotationQuaternion` is identity, and for directional and spot lights `direction` is `(0,0,−1)`.
- **Dedicated node.** Otherwise the light gets its own node, a child of the exported parent. It takes the light's `name`; its `translation` is `position`; for directional and spot lights its `rotation` is `normalize(rotationQuaternion ⊗ rotTo(direction))`. Rotation and translation are omitted at identity, and both go through the converting-pass rules when the parent's pass converts.
- **World placement.** A light without an ordinary exported parent (no parent, a camera or light parent, or an unexported parent) becomes a scene root at its current world transform, in the converting frame: `translation` is the world matrix translation with X negated, and a directional or spot light's `rotation` is `rotTo` of its direction carried through the world matrix's 3×3 (normalized, X negated). A point light has no rotation.

`gltf.extensions.KHR_lights_punctual = { lights: [...] }` is written once any light emits. The extension is optional (`extensionsUsed` only). Each exported light is recorded in `nodeIndex` and `nodeConvert`.

---

### Skinned meshes

Skins are out of scope (see Scope): `SkeletonData` holds only the bone texture, the vertex joint and weight arrays and the rest palette, with no joint nodes and no inverse bind matrices. For each exported mesh with a `skeleton`, the exporter:

- emits its geometry without `JOINTS_*` / `WEIGHTS_*`, so the mesh renders its unskinned vertex data (for loaded assets, usually the bind pose) at its node's transform;
- emits no `skins` entry and no `node.skin`;
- logs `Mesh "<name>" is skinned; skins are not exported, so it exports without skinning.`

Joint nodes are ordinary `TransformNode`s. They export with the rest of their hierarchy, and animation channels that target them still export.

---

### Animation export — `export-animations.ts`

One glTF animation is emitted per `scene.animationGroups` entry that carries `_gltfMixer` (the loader-retained `[clip, NodeRest[], SkeletonBinding[]]` triple). It is named `group.name` when non-empty; the loader's synthetic `animation_<i>` names export as-is. Groups without `_gltfMixer` (manual property-animation groups) log `Animation group "<name>" has no glTF-clip data; skipping.` Animations export last, after nodes, camera and lights, so every channel target already has its node index.

`collectAnimatedNodes(groups)` runs before the node sweep. It returns the set of scene nodes bound by a channel whose path is translation, rotation, scale or weights and whose target is an exportable node. The same channel eligibility drives `exportAnimations`. The set seeds root collection and forces TRS emission on those nodes.

#### Clip contract

Only `_gltfMixer[0]` (the clip) is read. The read surface, from `animation/types.ts`:

```typescript
// animation/types.ts (existing) — read surface only
interface AnimationSampler {
    readonly input: Float32Array;
    readonly output: Float32Array;
    readonly interpolation: InterpMode;
}
interface AnimationChannel {
    readonly samplerIdx: number;
    readonly nodeIdx: number;
    readonly path: TargetPath; /* + pointer-only writer fields */
}
interface AnimationClip {
    readonly name: string;
    readonly channels: readonly AnimationChannel[];
    readonly samplers: readonly AnimationSampler[];
    readonly duration: number;
    readonly frameRate?: number;
}
```

The numeric constants are imported from `animation/types.ts` (`PATH_*`, `INTERP_*`), never redeclared:

| `path`                 | glTF `target.path` | Output layout per key       |
| ---------------------- | ------------------ | --------------------------- |
| 0 (`PATH_TRANSLATION`) | `"translation"`    | VEC3                        |
| 1 (`PATH_ROTATION`)    | `"rotation"`       | VEC4 (xyzw)                 |
| 2 (`PATH_SCALE`)       | `"scale"`          | VEC3                        |
| 3 (`PATH_WEIGHTS`)     | `"weights"`        | SCALAR × morph-target count |
| 4 (`PATH_POINTER`)     | none               | skipped                     |

`interpolation`: 0 (`INTERP_LINEAR`) → LINEAR (omitted as the glTF default), 1 (`INTERP_STEP`) → STEP, 2 (`INTERP_CUBICSPLINE`) → CUBICSPLINE. CUBICSPLINE outputs hold `[inTangent, value, outTangent]` triplets per key. `input` is in seconds.

Sampler outputs hold glTF-native (right-handed) values: the loader dequantizes normalized and integer data at load (`gltf-sampler-denorm.ts`) and never converts handedness. `frameRate` has no glTF field and is unread.

#### Emission

Lite's clip model matches glTF, so export passes data through with no resampling or baking. For each group, channels are visited in clip order; a channel is skipped, with the stated warning, at the first check it fails:

1. **Pointer channels** (`PATH_POINTER`) resolve to load-time writer closures whose JSON pointers are not retained: `KHR_animation_pointer channel in "<name>" is skipped on export.`
2. **Target.** `clip.channels[i]` resolves its target through `targetedAnimations[i].target`; the loader builds that array 1:1 with `clip.channels`. For node and weights channels, the target is the live `TransformNode` (for weights, the node holding the morphed meshes). `target.node` is the target's exported index in `nodeIndex`; for a folded mesh, this is the absorbing node's index. A channel whose target is undefined or not exported: `Animation channel target (node <nodeIdx>) is not in the exported scene; skipping channel.`
3. **Path and sampler.** A channel with an unknown path or a missing sampler is skipped silently.
4. **Weights.** A weights channel on a node whose glTF mesh has no morph targets (its first primitive's `targets` is empty): `Animation "<name>" animates morph weights on a node without morph targets; skipping channel.` The target count is that primitive's `targets.length`.
5. **Sampler validation.** glTF needs at least one key and exactly `keys × values per key × targets (weights only) × (3 for CUBICSPLINE)` output values, where values per key are 3, 4 and 1 for translation/scale, rotation and weights. Otherwise: `Animation "<name>" has a sampler whose key and value counts do not match; skipping channel.`
6. **Duplicates.** A second channel for the same (node, path): `Animation "<name>" targets node <node> <path> more than once; keeping the first channel.`

Surviving channels are emitted as follows:

- **Samplers** are emitted on first use by a surviving channel, deduplicated within the animation by (clip sampler index, path, pass kind). `input` and `output` arrays are embedded and deduplicated across animations by array identity and variant. Input accessors carry min/max; output accessors carry none.
- **Converting-pass targets** get per-key conversion on a copy. For `translation`, X is negated on values and tangents. For `rotation`, the linear map `L` is applied to values and tangents. `scale` and `weights` pass through. (Clips never target a camera object: an imported animated camera collapses onto its animated source node, whose channels pass through.)
- **Rotation renormalization.** In both passes, non-spline rotation keys whose length differs from 1 by more than 0.0005 are renormalized on a copy, as glTF requires. Zero-length keys are left as they are. CUBICSPLINE outputs are never renormalized. Otherwise pass-through output embeds the source bytes unchanged.
- **Empty animations.** An animation that ends with zero channels is dropped.

Playback state (`isPlaying`, `speedRatio`, `loopAnimation`, `weight`, masks, blending) is runtime configuration outside the glTF data model and is not read.

---

### GLB assembly — `export-glb.ts`

```
Header (12 bytes):  magic 0x46546C67 ("glTF" LE) · version 2 · total length
JSON chunk:         length · type 0x4E4F534A ("JSON") · UTF-8 JSON, padded to 4 with 0x20
BIN chunk:          length · type 0x004E4942 ("BIN\0") · binary, padded to 4 with 0x00
```

The JSON is compact (`JSON.stringify`) and encoded with `TextEncoder`. The BIN chunk is always written, with length 0 when there is no binary data; Babylon.js does the same. The GLB specification allows omitting an empty BIN chunk, and glTF-Validator reports one only as information (`GLB_EMPTY_BIN_CHUNK`). But Lite's own GLB parser requires the chunk (see Known loader issues), and writing it keeps every export reloadable in Lite without a loader change. `buffers` is written only when the chunk has bytes. The result is `new Blob([bytes], { type: "model/gltf-binary" })`.

### Determinism & ordering

- **Node order:** the node sweep emits the collected roots in collection order (meshes → lights → camera → animation targets), each depth-first. Then the camera's own node, if it has one, and then light nodes in `scene.lights` order. Each of these is appended to its parent's `children`, or to `scenes[0].nodes` when it has no exported parent.
- **Array order:** first-emission order for every top-level array. Image and texture indices are assigned during resolution in capture order, never by GPU completion order. bufferView byte order follows the stable alignment sort.
- **Extensions:** `extensionsUsed` uses insertion order, which is capture order: `EXT_mesh_gpu_instancing` and the material extensions as the node sweep meets them (material extensions in the fixed writer order), then `KHR_lights_punctual`, then `KHR_texture_transform` at resolution. `extensionsRequired` is never written.
- **Accessor and bufferView order:** per primitive, `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0`, `TEXCOORD_1`, `COLOR_0`, then indices, then per morph target `POSITION` then `NORMAL`; a synthesized zero `TEXCOORD_0` is created after the material, so it comes last in `attributes`. Instance attributes follow their mesh, camera and light data have no accessors, animation accessors follow the node sweep, and PNG bufferViews are appended last, in image-index order. The stable alignment sort then fixes byte offsets.
- **Member order:** primitive `attributes`, `indices`, `mode`, `targets`, `material`; accessor `bufferView`, `componentType`, `count`, `type`, `byteOffset`, `normalized`, `max`, `min`; bufferView `buffer`, `byteLength`, `byteStride`, `target`, `byteOffset`; image `name`, `mimeType`, `bufferView`; camera `type`, `name`, then the projection object.
- **JSON member order:** top-level members serialize in the fixed order `asset`, `extensionsUsed`, `extensionsRequired`, `extensions`, `scene`, `scenes`, `nodes`, `meshes`, `materials`, `textures`, `images`, `cameras`, `animations`, `accessors`, `bufferViews`, `buffers`. Nested objects insert members in a fixed order at each construction site: node members as listed under Nodes, and texture slots, factor folds and `pbrMetallicRoughness` reserve their key at capture, so their position follows capture order whatever the readback completion order.
- **No volatile data:** there are no timestamps or random identifiers. Byte identity is guaranteed within one runtime only. PNG IDAT bytes come from the runtime's `CompressionStream`, and browsers may decode the same JPEG or WebP source to slightly different pixels before readback. Across browser engines, readback image bytes can therefore differ, and with them the bufferView offsets and lengths in the JSON.

### Default-value omission (consolidated)

"Within 1e-9" means `OMIT_EPSILON`; "=" means exact equality.

| Property                                                             | Omitted when                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| node `translation` / `scale` / `matrix`                              | within 1e-9 of `[0,0,0]` / `[1,1,1]` / identity            |
| node `rotation`                                                      | identity of either sign, within 1e-9                       |
| `primitive.mode`                                                     | 4 (TRIANGLES)                                              |
| `baseColorFactor`                                                    | within 1e-9 of `[1,1,1,1]` (after clamping)                |
| `metallicFactor` / `roughnessFactor`                                 | = 1 (after clamping)                                       |
| `alphaMode`                                                          | OPAQUE                                                     |
| `alphaCutoff`                                                        | = 0.5                                                      |
| `normalTexture.scale` / `occlusionTexture.strength`                  | = 1                                                        |
| textureInfo `texCoord`                                               | 0                                                          |
| `emissiveFactor`                                                     | within 1e-9 of `[0,0,0]`                                   |
| `doubleSided`                                                        | false                                                      |
| texture `sampler`                                                    | always (samplers are out of scope)                         |
| light `color` / `intensity` / `range`                                | = `[1,1,1]` / = 1 / `MAX_VALUE`, non-finite or not above 0 |
| `spot.outerConeAngle`                                                | within 1e-9 of π/4                                         |
| `perspective.zfar`                                                   | `farPlane ≥ 1e6` or `farPlane ≤ nearPlane`                 |
| `perspective.aspectRatio`                                            | no canvas, or a non-finite or non-positive ratio           |
| camera node `translation` / `rotation`                               | within 1e-9 of zero / identity                             |
| `KHR_texture_transform` `offset` / `scale` / `rotation` / `texCoord` | = `[0,0]` / `[1,1]` / 0 / 0                                |
| animation `interpolation`                                            | LINEAR                                                     |
| extension factor defaults                                            | per the writer digests (exact equality)                    |
| top-level arrays / `scene` / `buffers`                               | empty                                                      |

### Warnings & errors (consolidated)

**Thrown** (promise rejection): a GPU readback failure only. A failure is a rejected `mapAsync` (for example on device loss), or a synchronous failure while encoding or submitting the copy (a throwing `createBuffer`, `createTexture` or `submit`). Each readback destroys its own transient GPU objects on both paths. The failures are recorded in submission order, and the call rejects with the first one after every readback has settled. A non-`Error` value from `mapAsync` is thrown as it is, and a rejection with no reason (`undefined` or `null`) becomes `Error("Texture readback failed")`; a non-`Error` thrown synchronously while encoding or submitting is wrapped as `new Error(String(value))`.

Everything else degrades. **Warn and continue**, with every message the exporter can log (each is prefixed `[babylon-lite] glTF export: ` and logs once per distinct text per call):

| Area       | Message                                                                                                                                                                      | Consequence                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Nodes      | `Node "<name>" is part of a parent cycle; exporting the cycle from this node.`                                                                                               | the walk stops; the cycle exports from that node              |
| Nodes      | `Node "<name>" is parented to a camera, light or other non-node object; exporting it as a scene root at its current world transform.`                                        | world-placed root                                             |
| Nodes      | `Node "<name>" is an animation target parented to a camera, light or other non-node object; exporting it under a scene-root node at the parent's current world transform.`   | anchored root                                                 |
| Nodes      | `Node "<name>" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.`                                                                       | nearest TRS instead of `matrix`                               |
| Extras     | `Extras of "<name>" are not JSON-serializable; exporting without them.`                                                                                                      | extras dropped                                                |
| Geometry   | `Mesh "<name>" has no retained CPU geometry; exporting its node without a mesh.`                                                                                             | node without mesh                                             |
| Geometry   | `Mesh "<name>" has <normals\|tangents\|UVs\|second UV set\|vertex colors\|morph-target normals> whose length does not match its positions; exporting the mesh without them.` | attribute omitted (a second UV set puts the mesh in `"lost"`) |
| Geometry   | `Mesh "<name>" has <tangents\|a second UV set\|vertex colors> on the GPU only; exporting the mesh without them.`                                                             | attribute omitted (a second UV set puts the mesh in `"lost"`) |
| Geometry   | `Mesh "<name>" has morph targets whose length does not match its positions; exporting the mesh without them.`                                                                | all morph targets and weights dropped                         |
| Skins      | `Mesh "<name>" is skinned; skins are not exported, so it exports without skinning.`                                                                                          | exported unskinned                                            |
| Instancing | `Instance color alpha of mesh "<name>" is not represented in _COLOR_0; exporting RGB.`                                                                                       | RGB only                                                      |
| Materials  | `Material "<name>" of family "<family>" is not mapped to glTF; exporting the primitive without a material.`                                                                  | primitive without material                                    |
| Materials  | `Material "<name>" has factors outside [0, 1], which glTF cannot represent; exporting them clamped.`                                                                         | factors clamped                                               |
| Materials  | `1×1 factor texture for material "<name>" is not readable on this engine; exporting its factors without the texture.`                                                        | props' factors without the texel                              |
| Materials  | `Material "<name>" samples TEXCOORD_1 on a mesh whose second UV set is on the GPU only; exporting that mesh's material without its UV1 textures.`                            | UV1 slots omitted                                             |
| Materials  | `Material "<name>" is unlit with an emissive texture, which KHR_materials_unlit cannot represent; exporting it without the texture.`                                         | emissive texture omitted                                      |
| Materials  | `Material "<name>" both alpha-tests and blends, which glTF cannot represent; exporting it as BLEND.`                                                                         | BLEND                                                         |
| Materials  | `Material "<name>" has a clearcoat index of refraction of <ior>, which KHR_materials_clearcoat cannot represent; exporting it as 1.5.`                                       | IOR dropped, rest exports                                     |
| Materials  | `Material "<name>" remaps F0 under its clearcoat, which KHR_materials_clearcoat cannot represent; exporting without the remap.`                                              | remap dropped, rest exports                                   |
| Images     | `Texture pixels for material "<name>" are not readable on this engine; exporting the material without that texture.`                                                         | slot omitted                                                  |
| Images     | `Texture for material "<name>" is not a single-sampled 2D image; exporting the material without that texture.`                                                               | slot omitted                                                  |
| Images     | `Texture for material "<name>" is too large to read back on this device; exporting the material without that texture.`                                                       | slot omitted                                                  |
| Images     | `Texture for material "<name>" has a floating-point format; exporting it clamped to 8 bits.`                                                                                 | clamped to 8 bits                                             |
| Cameras    | `Camera fixup node "<name>" carries extra transform; exporting the camera as its own node.`                                                                                  | camera as its own node                                        |
| Cameras    | `Camera parent "<name>" has a singular world matrix; exporting the camera as a scene root.`                                                                                  | scene-root camera                                             |
| Cameras    | `Camera "<name>" has a mirrored view under its parent; exporting it unmirrored.`                                                                                             | exported unmirrored                                           |
| Cameras    | `Orthographic camera "<name>" has off-center bounds; exporting a symmetric projection.`                                                                                      | symmetric projection                                          |
| Cameras    | `Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.`                                                                                      | `xmag = ymag`                                                 |
| Lights     | `Hemispheric light is not representable in KHR_lights_punctual; skipping.`                                                                                                   | light skipped                                                 |
| Lights     | `Light type "<type>" is not exported.`                                                                                                                                       | light skipped                                                 |
| Lights     | `Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.`                                                                                            | falloff approximated                                          |
| Lights     | `Spot light "<name>" has a cone wider than KHR_lights_punctual allows; exporting a 180° cone.`                                                                               | outer angle clamped to π/2                                    |
| Lights     | `Spot light "<name>" has an empty cone; exporting the narrowest cone KHR_lights_punctual allows.`                                                                            | outer angle clamped to 1e-4                                   |
| Animations | `Animation group "<name>" has no glTF-clip data; skipping.`                                                                                                                  | group skipped                                                 |
| Animations | `KHR_animation_pointer channel in "<name>" is skipped on export.`                                                                                                            | channel skipped                                               |
| Animations | `Animation channel target (node <index>) is not in the exported scene; skipping channel.`                                                                                    | channel dropped                                               |
| Animations | `Animation "<name>" animates morph weights on a node without morph targets; skipping channel.`                                                                               | channel dropped                                               |
| Animations | `Animation "<name>" has a sampler whose key and value counts do not match; skipping channel.`                                                                                | channel dropped                                               |
| Animations | `Animation "<name>" targets node <index> <path> more than once; keeping the first channel.`                                                                                  | later channel dropped                                         |

In the animation rows, `<index>` in "Animation channel target (node <index>)" is the clip channel's source node index (`channel.nodeIdx`); in "targets node <index> <path>" it is the exported glTF node index. In the Extras row, `<name>` is the node's name, the extras-supplying mesh's name, the material's name, or `asset` for asset extras.

---

## Pipeline Configuration

The exporter creates render pipelines only for the decode blit (Readback, step 3), lazily on the first blit of a call and one per target format. They live in `ctx.blit` (`BlitResources`: bind group layout, shader module, pipeline layout and a format → pipeline map) and are released with the call. Nothing is cached at module level, which satisfies the zero-side-effect rule without the device-change invalidation a persistent cache would need. All objects carry labels starting with `gltf-export-`.

| State             | Value                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind group layout | binding 0: `texture`, `sampleType: "unfilterable-float"`, `viewDimension: "2d"`, visibility FRAGMENT. Any float-sampled format, including filterable ones, can bind as unfilterable-float. No sampler is used. |
| Pipeline layout   | one bind group layout (the one above)                                                                                                                                                                          |
| Shader module     | the inline WGSL below; entry points `vs` and `fs`                                                                                                                                                              |
| Source view       | `tex.texture.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 })`                                                                                        |
| Vertex stage      | fullscreen triangle from `vertex_index`, no vertex buffers                                                                                                                                                     |
| Fragment target   | `rgba8unorm-srgb` when the source format ends in `-srgb`, else `rgba8unorm`; no blend (replace), no write-mask override                                                                                        |
| Primitive         | `triangle-list`, `cullMode: "none"`                                                                                                                                                                            |
| Depth / stencil   | none                                                                                                                                                                                                           |
| Target texture    | same width and height as mip 0, `usage: RENDER_ATTACHMENT \| COPY_SRC`, destroyed after readback                                                                                                               |
| Staging buffer    | `size: bytesPerRow × height`, `usage: MAP_READ \| COPY_DST`, mapped with `mapAsync(0x0001)`, destroyed after readback                                                                                          |
| Render pass       | one color attachment, `loadOp: "clear"`, `clearValue: (0, 0, 0, 0)`, `storeOp: "store"`, one `draw(3)`                                                                                                         |

Matching the target's color space to the source is what keeps sRGB content byte-stable. Sampling an `-srgb` source returns linear values, and writing to an `-srgb` target re-encodes them, so the stored bytes come back as the source's stored bytes. A linear target would store linear values and produce a dark PNG.

Integer, depth and stencil formats are not float-sampled. They fail the float-sampleable precondition and take the unreadable-pixels warning.

## Shader Logic

The module text, exactly as inlined in `export-images.ts` (`BLIT_WGSL`):

```wgsl
@group(0) @binding(0) var src:texture_2d<f32>;
struct V{@builtin(position) p:vec4f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V{
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
return V(vec4f(p,0,1));
}
@fragment fn fs(v:V)->@location(0) vec4f{
return clamp(textureLoad(src,vec2i(v.p.xy),0),vec4f(0),vec4f(1));
}
```

`textureLoad` at the fragment's integer pixel coordinate copies texel `(x, y)` to `(x, y)`, with one fragment per target texel and no filtering, keeping storage row order. Row reversal, when required, happens on the CPU during image insertion. The clamp makes the float-to-8-bit conversion explicit. The text follows the repo's minimal-whitespace inline-WGSL convention (pillar 4).

## State Machine / Lifecycle

`exportSceneAsGlb` runs in five phases with no persistent state. Phase 1 is fully synchronous: it reads every piece of scene state the export uses, so nothing the render loop changes during the later `await`s can reach the output.

1. **Capture** (synchronous).
    1. Create the `ExportContext` with `createExportContext(scene.surface.engine, "Babylon Lite v" + VERSION)`. The document root is `{ asset: { version: "2.0", generator } }` with empty arrays and caches.
    2. `collectAnimatedNodes(scene.animationGroups)` and `cameraFixupOf(scene.camera)`.
    3. `collectRoots`: collect and partition roots, recording extra children for parent-only links and the first stripped root's extras. Snapshot those extras into `asset.extras`.
    4. `exportNodeTrees`: `export-nodes.ts` recurses depth-first per root. Nodes emit meshes (`export-geometry.ts`; geometry is copied into the BufferBuilder as it is emitted), and meshes emit materials (`export-materials.ts`). Materials write every non-texture member and call `captureTextureSlot` for each slot and record each fold. That records the pending slot and submits its readback, so the GPU copy is queued in this synchronous step too.
    5. `exportCamera`, `exportLights` and `exportAnimations`, in that order.
2. **Settle.** `await Promise.all` over every `pixelCache` promise (they never reject) and store each result in `resolvedPixels`. If any readback error was recorded, throw the first one in submission order. Each readback has already destroyed its own transient GPU objects.
3. **Resolve** (synchronous), in this order: `resolveFolds` (write the factor values, applying the omission rules, and cancel fallback slots of folded ORMs); `resolveTextureSlots` (write every textureInfo, or leave the slot unset when its pixels are null); the `afterResolve` callbacks in registration order; `finalizeMaterials` (remove empty `pbrMetallicRoughness` objects). Image and texture indices are assigned here, in capture order, so they never depend on GPU completion order.
4. **Encode.** `encodeImages` encodes each new image to PNG (`export-png.ts`) and adds its bytes as a bufferView, in image-index order.
5. **Assemble.**
    1. `buffers.finalize()` produces the BIN payload.
    2. `assembleDocument` builds the JSON: `extensionsUsed` / `extensionsRequired` from the context sets, the document-level `extensions` (the lights writer's `KHR_lights_punctual.lights`), `scene: 0` and `scenes` only when at least one root node exported, each non-empty top-level array, and `buffers: [{ byteLength }]` only when the BIN payload has bytes. Members follow the fixed order (Determinism).
    3. `export-glb.ts` frames the JSON (`JSON.stringify`) and BIN chunks, and the Blob of type `model/gltf-binary` resolves.

GPU objects created by readbacks (staging buffers, blit targets) are destroyed by each readback before the promise settles, on both the success and the failure path; the blit pipeline objects are dropped with the context.

---

## Babylon.js Equivalence Map

| Babylon Lite exporter                                                                                                                                                                                                                                                         | Babylon.js serializer (v9.30.0)                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exportSceneAsGlb(scene): Promise<Blob>`                                                                                                                                                                                                                                      | `GLTF2Export.GLBAsync(scene, name)` → `GLTFData.files`                                                                                                                                                                                              |
| fixed behavior set                                                                                                                                                                                                                                                            | `IExportOptions` (rows below give the mapping)                                                                                                                                                                                                      |
| whole scene exports; the caller restructures to filter                                                                                                                                                                                                                        | `shouldExportNode` predicate                                                                                                                                                                                                                        |
| every glTF-clip animation group exports                                                                                                                                                                                                                                       | `shouldExportAnimation` predicate                                                                                                                                                                                                                   |
| conversion-root stripping, always on                                                                                                                                                                                                                                          | `removeNoopRootNodes: true`                                                                                                                                                                                                                         |
| node, mesh and material `metadata.gltf.extras` → `extras`; `__root__` extras (the loader's copy of `asset.extras`) → `asset.extras`                                                                                                                                           | `metadataSelector` (default `metadata?.gltf?.extras`) → node `extras`; scene metadata → `scenes[0].extras`; no mesh, material or asset extras                                                                                                       |
| samplers pass through unresampled                                                                                                                                                                                                                                             | `animationSampleRate`, interpolation inference, baking                                                                                                                                                                                              |
| attributes export when retained; `_flatNormal` omits `NORMAL`                                                                                                                                                                                                                 | `exportUnusedUVs` UV pruning                                                                                                                                                                                                                        |
| uncompressed geometry                                                                                                                                                                                                                                                         | `meshCompressionMethod: "Draco"`                                                                                                                                                                                                                    |
| static ordered writer array                                                                                                                                                                                                                                                   | `RegisterExtension` registry, per-export instances                                                                                                                                                                                                  |
| pass split via the loader root shape `(−1,1,1)`                                                                                                                                                                                                                               | pass split via `useRightHandedSystem` + `IsNoopNode`                                                                                                                                                                                                |
| same mirror (negate X), quaternion sign pattern (ties to the later component) and `Rotate180Y` for static rotations                                                                                                                                                           | `ConvertToRightHandedPosition` / `ConvertToRightHandedRotation` / `Rotate180Y`                                                                                                                                                                      |
| animation rotation keys and tangents use the unsigned linear map `L`; clips never target a camera object                                                                                                                                                                      | every key goes through `ConvertToRightHandedRotation` (with sign canonicalization); camera keys also through `Rotate180Y`                                                                                                                           |
| `matrix` emitted for `_localMatrix` nodes; TRS otherwise                                                                                                                                                                                                                      | always TRS (`C·M·C` appears only for inverse bind matrices)                                                                                                                                                                                         |
| winding from `_authoredSign` × pass kind                                                                                                                                                                                                                                      | winding from `_getEffectiveOrientation` × `wasAddedByNoopNode`                                                                                                                                                                                      |
| per-slot textureInfo; packing without inter-view padding                                                                                                                                                                                                                      | shared `ITextureInfo` per texture; same unpadded alignment sort                                                                                                                                                                                     |
| every image read back and encoded as PNG (source bytes are out of scope); images dedupe by content                                                                                                                                                                            | cached source bytes reused when the texture came from a URL and is not `invertY`-flipped (PNG, JPEG, WebP, AVIF, KTX2), else `GetTextureDataAsync` + canvas encoding in the texture's MIME type (PNG fallback); images per `InternalTexture` + MIME |
| KTX2 sources read back as PNG (the loader strips their textureInfos); no `KHR_texture_basisu` or `EXT_texture_avif` output                                                                                                                                                    | KTX2 / AVIF bytes under `KHR_texture_basisu` / `EXT_texture_avif` (used + required)                                                                                                                                                                 |
| no samplers (out of scope); readers apply glTF default sampling                                                                                                                                                                                                               | sampler table from `BaseTexture` properties                                                                                                                                                                                                         |
| spec-gloss re-emitted via the archived extension + MR fallback                                                                                                                                                                                                                | spec-gloss re-solved to metallic-roughness per texel                                                                                                                                                                                                |
| same Standard→MR formulas (`linear(diffuse) × 0.5`, `SpecularPowerToRoughness`); additionally keeps the ambient texture's `texCoord`, converts `emissiveColor` to linear, inverts bump red (and green when flipped), and chooses BLEND from `alpha < 1` or an opacity texture | `_ConvertToGLTFPBRMetallicRoughness`; drops the occlusion `texCoord`; writes `emissiveColor` unconverted; BLEND only for `ALPHA_COMBINE`                                                                                                            |
| same emissive-strength normalization                                                                                                                                                                                                                                          | `KHR_materials_emissive_strength`                                                                                                                                                                                                                   |
| light collapses onto its parent node only when the light's local transform is identity-like                                                                                                                                                                                   | `IsChildCollapsible` / `CollapseChildIntoParent`: a light that is its unscaled parent's only child is composed into the parent's TRS                                                                                                                |
| spot cone from the full `angle` (`outerConeAngle = angle / 2`; inner at its schema default)                                                                                                                                                                                   | `innerConeAngle = innerAngle / 2`, `outerConeAngle = angle / 2`                                                                                                                                                                                     |
| camera fixup collapse (`(−a, a, a)`, pristine shape only; residual → own node + warning)                                                                                                                                                                                      | camera parent collapse (`(−1,1,1)`; residual composed into the parent via `CollapseChildIntoParent`)                                                                                                                                                |
| no skins (out of scope); skinned meshes export unskinned with a warning                                                                                                                                                                                                       | skins from `Bone.getAbsoluteInverseBindMatrix()` + linked nodes                                                                                                                                                                                     |
| morph deltas pass through (position, normal); no `targetNames`                                                                                                                                                                                                                | morph deltas recomputed (position, normal, tangent, color)                                                                                                                                                                                          |
| line systems use `LineMaterial` (family `"shader"`), so line and point primitives export without a material, with the unmapped-family warning                                                                                                                                 | `LinesMesh` / `GreasedLineBaseMesh` emit a minimal per-submesh color material                                                                                                                                                                       |
| thin instances → `EXT_mesh_gpu_instancing`                                                                                                                                                                                                                                    | same extension from `thinInstanceGetWorldMatrices()`                                                                                                                                                                                                |
| GLB framing with a BIN chunk always present (empty when there is no binary data); Blob type `model/gltf-binary`                                                                                                                                                               | same framing and empty BIN chunk; Blob type `application/octet-stream`                                                                                                                                                                              |
| no `KHR_interactivity` export (flow graphs are out of scope)                                                                                                                                                                                                                  | `khrInteractivity` option exports `KHR_interactivity` after final index remapping, and disables no-op root removal                                                                                                                                  |
| tangent `w` negated in converting passes (a mirror reverses the bitangent's handedness)                                                                                                                                                                                       | keeps tangent `w` and only normalizes xyz                                                                                                                                                                                                           |
| pass-through normals and tangents verbatim when unit within 0.0005, otherwise renormalized on a copy; converting passes always renormalize                                                                                                                                    | normalizes normal and tangent xyz in every case, on a copy of the buffer                                                                                                                                                                            |
| indices keep a retained 32-bit width, otherwise narrow to `UNSIGNED_SHORT` when every index is below 65535                                                                                                                                                                    | width follows the mesh's index buffer (`is32Bits`), with no narrowing                                                                                                                                                                               |
| a node whose parent is a camera, a light or another non-node world-matrix provider exports as a scene root at its world transform, with a warning                                                                                                                             | cameras and lights are nodes of the same hierarchy (`getChildren()`), so their children export as glTF children                                                                                                                                     |
| Standard `disableLighting`: base color `clamp(emissive × diffuse)^2.2`, no 0.5 factor, no metallic or roughness, diffuse texture only. Standard alpha: `MASK` only with a diffuse texture, alpha 1 and no opacity texture; `alpha < 1` or an opacity texture → `BLEND`        | `KHR_materials_unlit` is attached for `disableLighting` while the lit conversion factors are kept; `BLEND` only for `ALPHA_COMBINE`                                                                                                                 |
| `KHR_materials_ior` also derives `ior = (1 + √r) / (1 − √r)` from a PBR `reflectance` other than 0.04 (no spec-gloss texture), because Lite's dielectric F0 is `reflectance`                                                                                                  | writes `indexOfRefraction` of a `PBRMaterial` only when it differs from 1.5                                                                                                                                                                         |

Serializer features with no Lite counterpart are absent from this module: `KHR_materials_coat`, `KHR_materials_fuzz`, `KHR_materials_volume_scatter`, `KHR_materials_diffuse_roughness`, the experimental `KHR_materials_openpbr` and its `OpenPBRMaterial` path, and `EXT_lights_area`. The seams above (writer list, inputs table, image sources) are where each would land.

---

## Dependencies

Imports are from the module files, not the package root.

- **Math** (`math/`): `decomposeMat4(m): { translation, rotation, scale }` (folds a negative determinant into −Y scale), `composeMat4` (the TRS-decomposability check), `multiplyMat4(a, b)`, `invertMat4(m): Mat4 | null`, `mat4Determinant3(m)` (the mirrored-view test), `srgbByteToLinear(b)` (`math/color.js`) and the `Mat4` type. The conversion formulas in `export-handedness.ts` are self-contained. `Mat4` is a branded readonly type; raw arrays such as a glTF `_localMatrix` are cast.
- **Scene state:** the Inputs table, including the retained CPU arrays, `MorphTargetData`, `ThinInstanceData` and `AnimationGroup._gltfMixer`.
- **Engine:** `_device` for readback and the decode blit; `gpu-flags.js` (`BU`, `SS`, `TU`) for buffer, shader-stage and texture usage bits; `scene.surface.canvas` for the camera aspect; `VERSION` (`engine/version.js`) for `asset.generator`. A null engine is detected by an absent `_device`.
- **Material helpers:** `getMaterialSource`, `getMaterialFamily`.
- **Texture helpers:** `getTextureTransform`.
- **Camera helper:** `getEffectiveAspectRatio`.
- **Clip constants:** `PATH_*` / `INTERP_*` from `animation/types.ts`.
- **glTF JSON types:** declared by the exporter in `export-gltf-types.ts` (the loader has none).
- **Web platform:** `TextEncoder`, `CompressionStream("deflate")`, `Blob`. No DOM, no canvas; worker-safe.
- **No third-party code.** PNG encoding, GLB framing and the conversions are in-module.

### Known loader issues

Found while specifying this module. They are loader bugs, out of scope here (see Scope), and fixing them changes code that every glTF scene fetches, so each needs its own change and approval under GUIDANCE pillar 4.

- **JSON-only GLB.** `parseGlbContainer` (`gltf-glb-parser.ts`) reads a BIN chunk header unconditionally. A valid GLB with no BIN chunk throws `RangeError: Offset is outside the bounds of the DataView`. This module always writes a BIN chunk, so its own output is unaffected.
- **Node-less documents.** `load-gltf.ts` reads `json.nodes.length` without a guard, although glTF makes `nodes` optional. An empty scene's asset-only export therefore does not reload in Lite; tests assert it structurally.
- **Double factor alpha (fixed).** Before Babylon Lite #814 (2026-10-17), BLEND and MASK materials applied glTF factor alpha twice. The loader now keeps it only in `alpha`; the exporter's alpha rule assumes the fixed loader.

### Lite renderer quirks observed

Found while checking exporter output against what Lite renders. They are renderer gaps, not exporter behaviour, and are follow-ups outside this module. The exporter writes the glTF the source material describes; Lite's reimport may not render it identically until these are fixed.

- **Normal scale.** The PBR renderer applies `normalTextureScale` only when the template extension is active (`pbr-template.ts`, near line 314). A `normalTexture.scale` exports regardless.
- **Occlusion strength.** `occlusionStrength` is applied only by the reflectance fragment.
- **Iridescence UV1.** An iridescence texture with `_texCoord === 1` but no core `_uv2Mask` bit never gets the `PBR2_HAS_UV2` shader flag. The exporter treats such a texture as UV1-selected, as the loader's `_texCoord` says.
- **Light range.** Light `range` is ignored under physical falloff.

---

## Test Specification

Three layers, mapped onto TESTING.md's categories:

- Vitest unit tests over fabricated plain-data scenes (`tests/lite/unit/export-gltf/`).
- Playwright plumbing tests over real exports (`tests/lite/plumbing/export-gltf.spec.ts`, with the lab page `lab/lite/export-gltf-test.html`).
- Playwright visual parity scenes 316 to 320 (`tests/lite/parity/scenes/scene3NN-gltf-export-*.spec.ts`), ported from the Babylon.js serializer's visualization tests.

The first two layers include ports of the Babylon.js serializer's unit and integration tests (Babylon.js test ports, below).

Because Lite entities are plain data, unit-test stubs are object literals; no engine or real GPU is required.

### Unit tests — Vitest, `tests/lite/unit/export-gltf/`

493 tests in ten files, built on one harness.

**Harness — `export-test-utils.ts`.** It supplies everything a test needs without a GPU:

- `createFakeDevice(options)` returns a fake `GPUDevice` and counters (`copies`, `blits`, `buffersCreated` / `Destroyed`, `texturesCreated` / `Destroyed`). It implements exactly what the readback uses: command encoders with `copyTextureToBuffer` and a one-draw blit render pass, staging buffers with `mapAsync`, transient textures, and stub shader modules, layouts and pipelines. `failMap` makes every `mapAsync` reject, `failCreateBuffer` makes `createBuffer` throw synchronously, and `maxBufferSize` sets `limits.maxBufferSize`.
- `createTexture(width, height, pixels, options)` builds a `Texture2D` over a fake GPU texture that carries its mip-0 bytes (format, usage, `invertY`, wrapper fields such as `uScale` / `_hasTx` / `_texCoord`, dimension, layers and sample count are options).
- `createMesh(name, options)` builds a plain-data `Mesh` with CPU arrays (default: a unit quad facing −Z), optional GPU-only attributes, `_authoredSign`, retained `_cpuGpuIndices` and a material; `attach(child, parent)` links `parent` and `children` the way `addToScene` does.
- `createScene(options)` builds a plain-object `SceneContext` (meshes, lights, camera, animation groups, an optional fake device and canvas).
- `exportAndParse(scene)` runs the export with `console.warn` captured (prefix stripped), and returns the parsed JSON, BIN payload, bytes and warnings. `parseGlb`, `readAccessor`, `readBufferView` and `decodePng` read the output back.

**Files and coverage.**

| File                                | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handedness.test.ts`                | the quaternion sign pattern against `quat(C·mat(q)·C)` over randomized quaternions, pivot non-negative, exact ties (y over x, w over z), `L` alone for animation keys, translation and matrix conversion, `Rotate180Y`, `rotTo` including the opposite case, `needsWindingFlip` for the four policy cases, `nearlyEqual`, `canonicalizeQuat` / `normalizeQuat`                                                                                                                                                                                               |
| `buffers-glb-png.test.ts`           | `BufferBuilder` (stable alignment sort, no padding, component alignment, deferred and omitted `byteOffset`, dedup, snapshotting, optional accessor members), `computeMinMax`, `frameGlb` (header, chunk types, padding, UTF-8 measuring, zero-length BIN), `crc32` (against `zlib.crc32`), `encodePng` (inflate round trip, storage and reversed rows)                                                                                                                                                                                                       |
| `geometry.test.ts`                  | attributes (`_flatNormal`, GPU-only and length-mismatch omission with warnings), converting-pass conversion (position and normal mirror, tangent `w` negation, pass-through unit-length repair), index width and narrowing, winding (incl. strip expansion), topology modes, non-indexed and empty geometry, morph targets (mismatch drop, normals need a base `NORMAL`, weights), skinned meshes, thin instances (decomposition, identity-attribute omission, `count` vs capacity, colors and alpha warning)                                                |
| `nodes.test.ts`                     | root collection (order, animated meshless roots, loader-root stripping and its fences, parent-only children, removed nodes, lights and cameras in `children`, non-node parents as world-placed roots or anchors, parent cycles), node transforms (omission tolerance, small real values kept, `matrix` conversion, shear warning, animated nodes), mesh folding and its fences (incl. instance colors and dropped morph targets), mesh sharing, extras (first contributor, shared-object rule, snapshot, non-serializable), determinism and read-only export |
| `materials-pbr.test.ts`             | PBR core: base color and alpha, 1×1 folds (incl. decode modes, the bake grid and opaque alpha), metallic-roughness and occlusion rules, UV1 occlusion, texture transforms, UV1-selected slots and UV states, normal / emissive / alpha / culling, null engine, family dispatch, material name and extras                                                                                                                                                                                                                                                     |
| `materials-standard.test.ts`        | Standard→metallic-roughness factors and clamping, texture slots and UV sets, shared-path and per-texture-path UV mapping and row order (incl. the rotation convention against the shader's UV matrix), bump inversion, emissive, alpha (MASK / BLEND rules), culling, unlit                                                                                                                                                                                                                                                                                  |
| `material-writers.test.ts`          | each of the 13 writers: triggers, defaults, texture transform gates, and bookkeeping of `extensionsUsed` (unlit tint, emissive strength, clearcoat warnings, sheen re-reference, iridescence UV1, anisotropy rotation, ior incl. reflectance-derived, specular, transmission, volume, dispersion, diffuse transmission, spec-gloss incl. occlusion from the ORM and no readback for a skipped ORM)                                                                                                                                                           |
| `images.test.ts`                    | readback paths (direct, blit, padded rows, unreadable formats, oversize), null engine, float clamp, image identity and dedup, image naming, sequential PNG encoding in index order with the pixel buffers taken off the context, readback failure (rejection after all settle, staging buffers destroyed, no unhandled rejection), synchronous submission failure (transient objects destroyed), empty scene, Blob type, byte-identical repeat exports                                                                                                       |
| `bjs-ports.test.ts`                 | the Babylon.js serializer tests that build their scene natively (Babylon.js test ports, below)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cameras-lights-animations.test.ts` | cameras (projection, `zfar` and aspect rules, orthographic forms and warnings, converting and pass-through placement, fixup collapse, residual fixup, fixup without a parent), lights (block defaults, colour peak, cone clamps, collapse, dedicated nodes, world-placed lights, one light per node), animations (conversion of values and tangents, renormalization, sampler validation, pointer and duplicate skips, dedup, empty animation)                                                                                                               |

Tests assert on parsed GLB output, warning texts and counters of the fake device, so the warning list under Warnings & Errors is checked message by message.

### Loader-convention invariants

These exporter rules each invert a specific loader convention. Each pair is kept honest by the listed tests (unit files under `tests/lite/unit/export-gltf/`):

| Invariant (loader convention ↔ exporter rule)                                                                                                           | Enforcing tests                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `uAng` stores glTF `rotation` verbatim ↔ re-emitted unchanged                                                                                           | `materials-pbr.test.ts` (texture transforms)                                                     |
| native generators wind against their normals and glTF data with them, recorded by `_authoredSign` ↔ the winding table                                   | `handedness.test.ts` (`needsWindingFlip`) · `geometry.test.ts` (winding) · plumbing native scene |
| `angle` stores the full cone ↔ `outerConeAngle = angle / 2`                                                                                             | `cameras-lights-animations.test.ts` (lights)                                                     |
| 1×1 bakes: base color `rgba8unorm-srgb`, ORM `[255, rough, metal, 255]` ↔ factor folds                                                                  | `materials-pbr.test.ts` (base color, metallic-roughness)                                         |
| ORM packing R=occlusion / G=roughness / B=metallic ↔ `ormTexture` re-emitted as `metallicRoughnessTexture`                                              | `materials-pbr.test.ts` (metallic-roughness and occlusion)                                       |
| sheen roughness packed in the color texture's alpha ↔ `sheenRoughnessTexture` re-references `texture`                                                   | `material-writers.test.ts` (sheen)                                                               |
| loader conversion root `(−1,1,1)` ↔ root stripping + pass-through state                                                                                 | `nodes.test.ts` (root collection) · plumbing asset round trips                                   |
| camera fixup `(−a, a, a)`, 180° yaw camera-local ↔ pristine fixup collapse                                                                              | `cameras-lights-animations.test.ts` (fixup nodes)                                                |
| clip constants (`PATH_*` 0–4, `INTERP_*` 0–2) ↔ the clip-contract tables                                                                                | `cameras-lights-animations.test.ts` (animations)                                                 |
| Standard `perturbNormal` scales N by `1 / bumpLevel` before renormalizing ↔ `normalTexture.scale = bumpLevel`                                           | `materials-standard.test.ts` (texture slots)                                                     |
| Standard `perturbNormal` frame `(−T₀, −B₀)` vs the PBR cotangent frame `(T₀, −B₀)` ↔ red (and, when flipped, green) inversion                           | `materials-standard.test.ts` (bump inversion)                                                    |
| the loader uploads glTF images unflipped ↔ PBR slots read back in storage row order                                                                     | `images.test.ts` (readback paths)                                                                |
| no-`NORMAL` primitives flagged `_flatNormal` ↔ `NORMAL` omitted                                                                                         | `geometry.test.ts` (attributes)                                                                  |
| Standard flips UV0 slots by the material-wide orientation (shared path) or per texture (per-texture path), PBR does not ↔ per-slot row order and offset | `materials-standard.test.ts` (UV mapping, both paths)                                            |

### Plumbing tests — Playwright, `tests/lite/plumbing/`

28 tests in one spec: 9 asset round trips, the native scene, and 18 Babylon.js test ports.

Plumbing runs real exports in a browser. The lab page `lab/lite/export-gltf-test.html` (script `lab/lite/src/export-gltf-test.ts`) creates one engine and exposes `window.exportGltfTest`. The spec loads the page once per worker (`beforeAll`) and every test shares that page and engine, so each call disposes the scenes it creates and leaves no engine opt-in enabled:

- `roundTripAsset(url)` enables glTF cameras, loads the asset into a scene, and runs the round trip below with two stages.
- `roundTripNative()` builds a native scene (a PBR box and a Standard sphere under a rotated, scaled group, both with a 4×4 checker texture, the sphere's with `uvScale` `[2, 3]`; a spot, a point and a directional light; a free camera) and runs the round trip with three stages.
- `exportGlb(glbBase64, options?)` enables glTF cameras, loads a GLB into a fresh scene (adopting its first camera), exports it once, and returns the export (base64) and its warnings. `retainCpuVertexData: true` calls `enableDeviceLostSceneRecovery(engine)` before loading, so vertex colors stay on the CPU and export, and disables it again after the export.
- **Round trip.** Export the source scene (`first`), reload that GLB into a new scene and export it (`second`), and, for the native scene only, reload that and export again (`third`). It returns the GLBs as base64, every warning logged, and mesh / light / camera counts of the source and the first reload.

`export-gltf.spec.ts` visits 9 local assets: `NegativeScaleTest`, `Node_NegativeScale_01`, `MirroredDoubleSided`, `Material_03`, `Animation_SamplerType_01`, `Buffer_Interleaved_03`, `Mesh_PrimitiveMode_11`, `CarbonFiberWheel` and `chesspiece`. For each it asserts a well-formed GLB header and `asset.version` 2.0, equal mesh and light counts after the first reload, and the idempotence gate: `first === second`. The native scene asserts no warnings, `KHR_lights_punctual` and `KHR_texture_transform` in `extensionsUsed`, one camera, two materials, one image (both materials sample the same checker pixels, so content dedup applies), equal counts and a reloaded camera, and `second === third` only: the first reload quantizes what the loader bakes (1×1 factor textures) and names unnamed cameras, so the first export of a native scene is not a fixed point. The spec saves the first and second GLBs of every case under `test-results/export-gltf/`.

The same spec holds the Babylon.js test ports that start from a hand-built glTF document and so need Lite's real loader (next section). `export-gltf-helpers.ts` supplies: `createTriangleFixture()` (one node and mesh, a +Z-facing triangle with `POSITION`, `NORMAL`, `uint16` indices and one metallic-roughness material, plus `addAccessor` for extra data), `buildGlb(json, bin)`, `parseGlb` and `readAccessor`.

### Babylon.js test ports

The Babylon.js serializer suites (`packages/dev/serializers/test/`, `master` @ `676f462`) are ported scenario by scenario, re-expressed in Lite terms rather than copied. A port keeps the Babylon.js test title, under a `describe` named after the Babylon.js file. Scenarios that start from a hand-built glTF document run in the plumbing spec `export-gltf.spec.ts`; scenarios that build a scene natively run in the unit file `bjs-ports.test.ts`. **Ported** keeps the scenario and its assertions. **Adapted** keeps the intent, maps it onto Lite's model, and says how. Tolerances are Babylon.js's own, except where a value passes through a quantizing loader bake. In that case the reason is noted below and in the test.

**Unit suite — `test/unit/glTF/`**

| Babylon.js test                                                                                                                                        | Status here                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glTFExporter`: writes a .gltf file that references a separate .bin file                                                                               | not applicable: the API is GLB-only                                                                                                                                                                            |
| `glTFExporter`: writes a binary glTF with a JSON chunk followed by a BIN chunk                                                                         | ported (unit)                                                                                                                                                                                                  |
| `glTFExporter`: preserves node hierarchy, names and transforms of an imported asset                                                                    | ported (plumbing)                                                                                                                                                                                              |
| `glTFExporter`: exports only the nodes accepted by shouldExportNode                                                                                    | adapted (unit): no export options; the skipped node is taken out of `scene.meshes`                                                                                                                             |
| `glTFExporter`: round trips vertex data and mode of a primitive                                                                                        | ported (plumbing, with `retainCpuVertexData` so `COLOR_0` survives the load)                                                                                                                                   |
| `glTFExporter`: omits texture coordinates that no texture uses unless exportUnusedUVs is set                                                           | not applicable: no UV pruning; every retained UV set exports                                                                                                                                                   |
| `glTFExporter`: exports unit-length normals                                                                                                            | adapted (plumbing): Babylon.js rewrites the normals after loading; Lite's `updateMeshNormals` writes the GPU only (Scope, partial vertex updates), so the length-5 normals are authored in the source document |
| `glTFExporter`: preserves geometry and material for sub meshes with offset vertex and index ranges                                                     | adapted (unit): Lite has no sub-meshes; two child meshes over one shared position array, with index ranges `[0,1,2]` and `[3,4,5]` and materials `a` and `b`, fold into one glTF mesh with two primitives      |
| `glTFExporter`: round trips perspective and orthographic cameras                                                                                       | adapted (plumbing): only `scene.camera` exports, so each camera round-trips in its own document                                                                                                                |
| `glTFAnimation`: round trips animation channels, interpolation modes and keyframe times                                                                | ported (plumbing)                                                                                                                                                                                              |
| `glTFAnimation`: exports only the animations accepted by shouldExportAnimation                                                                         | adapted (unit): no export options; the group is taken out of `scene.animationGroups`                                                                                                                           |
| `glTFSkinsAndMorphTargets`: round trips a parented skin (`useRightHandedSystem` false / true)                                                          | not ported: skins are out of scope                                                                                                                                                                             |
| `glTFSkinsAndMorphTargets`: round trips morph targets with their default weights and names                                                             | adapted (plumbing): target deltas and weights are asserted; `extras.targetNames` is out of scope                                                                                                               |
| `glTFSkinsAndMorphTargets`: exports morph target deltas on each sub mesh primitive                                                                     | adapted (unit): two child meshes sharing one position array and one morph-target set                                                                                                                           |
| `glTFMaterialExporter`: NullEngine / cached texture path (3 tests)                                                                                     | not ported: original image bytes are out of scope (every image is read back and written as PNG)                                                                                                                |
| `glTFMaterialExporter`: round trips metallic-roughness factors, emissive and double-sidedness                                                          | ported (plumbing); `baseColorFactor` RGB within 0.005, because the loader bakes it into a 1×1 `rgba8unorm-srgb` texture (half an sRGB step is at most ≈0.0045 in linear)                                       |
| `glTFMaterialExporter`: round trips the alpha modes                                                                                                    | ported (plumbing)                                                                                                                                                                                              |
| `glTFMaterialExporter`: round trips `KHR_materials_` ior, emissive_strength, transmission, volume, specular, sheen, iridescence, anisotropy, clearcoat | ported (plumbing, 9 tests)                                                                                                                                                                                     |
| `glTFMaterialExporter`: round trips unlit materials                                                                                                    | ported (plumbing); `baseColorFactor` RGB within 0.005, as above                                                                                                                                                |
| `khrInteractivity` (5 tests)                                                                                                                           | not ported: `KHR_interactivity` export is out of scope                                                                                                                                                         |

**Integration suite — `test/integration/glTFSerializer.test.ts`** (unit layer; tests already covered by the module's own files point there)

| Babylon.js test                                                                         | Status here                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| should convert Babylon standard material to metallic roughness                          | ported (`materials-standard.test.ts`: default white diffuse → 0.5, `diffuse^2.2 · 0.5`, specularPower 64 → roughness 0.328809)                                                                                                                                                                           |
| should solve for metallic                                                               | not applicable: Lite has no specular-glossiness → metallic solver; spec-gloss materials re-emit `KHR_materials_pbrSpecularGlossiness`                                                                                                                                                                    |
| should serialize empty Babylon window.scene to glTF with only asset property            | ported (`images.test.ts`)                                                                                                                                                                                                                                                                                |
| should serialize sphere geometry in window.scene to glTF                                | ported (`bjs-ports.test.ts`): the document shape differs by design: `TEXCOORD_0` is kept and a material-less mesh gets no default material, so 8 top-level keys and 4 accessors / bufferViews where Babylon.js has 9 keys, 3 accessors and 4 bufferViews                                                 |
| should serialize translation / scale / rotation quaternion animation to glTF            | ported (`bjs-ports.test.ts`): channel target and path, sampler `input` / `output` wiring, key accessor (`SCALAR` float, `min` / `max`), value accessor (VEC3 / VEC4, matching count) and totals. LINEAR is omitted as the glTF default where Babylon.js writes it                                        |
| should serialize combined animations to glTF                                            | adapted (`bjs-ports.test.ts`): Babylon.js's two `Animation`s on one node become two single-channel clip groups, giving two glTF animations                                                                                                                                                               |
| should serialize single component translation animation to glTF                         | not applicable: Lite clips are full-vector; there are no property-path animations                                                                                                                                                                                                                        |
| should serialize point light / directional light to glTF                                | ported (`cameras-lights-animations.test.ts`)                                                                                                                                                                                                                                                             |
| should serialize spot light / multiple lights to glTF                                   | ported (`bjs-ports.test.ts`); `innerConeAngle` is not exported (see Scope)                                                                                                                                                                                                                               |
| serializes scene and node metadata                                                      | adapted (`bjs-ports.test.ts`): node extras come only from `metadata.gltf.extras`; `SceneContext` carries no metadata, so the scene-level assertion is dropped                                                                                                                                            |
| exports one mesh that is shared by all instances                                        | adapted (`nodes.test.ts`, mesh sharing): Lite has no instanced meshes; same-named nodes sharing arrays and material share one glTF mesh                                                                                                                                                                  |
| can export instances without their source mesh                                          | adapted (`bjs-ports.test.ts`): the source is taken out of `scene.meshes`; the instances carry the source's name, as sharing requires                                                                                                                                                                     |
| should not export a root conversion node                                                | ported (`nodes.test.ts`)                                                                                                                                                                                                                                                                                 |
| node animations / animation group targeting a meshless root node (RH scene)             | ported (`nodes.test.ts`); Lite animations are clip groups, so the two cases are one                                                                                                                                                                                                                      |
| should not duplicate a shared texture between materials                                 | ported (`images.test.ts`)                                                                                                                                                                                                                                                                                |
| should not convert right-handed node transformations                                    | ported (`bjs-ports.test.ts`: translation, rotation and scale of a parent / child pair under a stripped loader root)                                                                                                                                                                                      |
| should consistently convert left-handed node transformations                            | ported (`nodes.test.ts`, `handedness.test.ts`)                                                                                                                                                                                                                                                           |
| should reparent children of unexported node to nearest ancestor                         | adapted (`bjs-ports.test.ts`): there is no per-node export filter, an exported node pulls in its whole `parent` chain, and `removeFromScene` removes descendants too. The children are therefore reparented with `setParent`, which keeps their world transform, before the intermediate node is removed |
| converts a shared float MatricesIndicesKind vertex buffer                               | not ported: skins are out of scope                                                                                                                                                                                                                                                                       |
| uses KHR_texture_basisu to export a KTX2 image                                          | adapted (`bjs-ports.test.ts`): a compressed-format source exports through the blit as PNG; neither `KHR_texture_basisu` nor `EXT_texture_webp` is written                                                                                                                                                |
| uses EXT_texture_webp to export a WEBP image                                            | adapted, no separate test: WebP sources decode to 8-bit textures and export as PNG through the same readback paths `images.test.ts` covers                                                                                                                                                               |
| KHR_interactivity export after final entity remapping / RH identity root for references | not ported: `KHR_interactivity` export is out of scope                                                                                                                                                                                                                                                   |

### Round-trip idempotence

For glTF assets, `export(load(export(load(asset))))` is byte-identical to `export(load(asset))`, so `first === second`; for a native scene only `second === third` holds. The first export drops what is out of scope; after that, the output is a fixed point. Export is deterministic (`nodes.test.ts`, determinism), so one more reload and export of an asset would repeat `second`. `export-gltf.spec.ts` asserts this for every case.

### Visual parity suite — Playwright, `tests/lite/parity/scenes/`

The Babylon.js `"GLTF Serializer"` visualization tests (`packages/tools/tests/test/visualization/config.json`, 26 entries) are ported as Lite parity scenes, following GUIDANCE §2's scene checklist. Besides its bundle page (`bundle-sceneN.html`), each scene has two pages:

- **Babylon.js reference page** (`lab/lite/babylon-ref-sceneN.html`, `lab/lite/src/bjs/sceneN.ts`). It runs the test's playground as-is (same values, order and URLs), with the test's `replace` options as query-parameter variants and Babylon.js's seeded `Math.random`, through `@babylonjs/serializers` (a lab dev dependency). Before its golden was captured, each page was checked against Babylon.js's own reference image for that test, at the test's 600×400 size with antialiasing off (`?antialias=0`), using Babylon.js's pass rule (pixelmatch threshold 0.035, differing pixels ≤ the test's `errorRatio` %).
- **Lite page** (`lab/lite/sceneN.html`, `lab/lite/src/lite/sceneN.ts`). It builds the same scene with the public Lite API, calls `exportSceneAsGlb`, reloads the Blob with `loadGltf`, and repeats the snippet's post-load steps. Every place where Lite cannot express a snippet step is named in the page header and the spec header.

The golden (`reference/lite/<slug>/babylon-ref-golden.png`, committed) is captured once from the reference page at 1280×720. The spec compares the Lite page with it against the scene's `maxMad`. Variants that share one Babylon.js reference image share one golden.

A test is kept only when its Lite page matches the golden closely. A test that would pass only through a threshold covering deliberately skipped work (an out-of-scope exporter capability, or a Lite renderer gap outside this module) is not kept. Its scene is preserved on branch `wip/gltf-export-parity-blocked`; the blockers are listed under Deferred follow-up work below.

| Scene | Babylon.js test(s) · playground                                | Lite MAD | `maxMad` | Notes                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 316   | with Negative World Matrix (left handed, twice) · `#KX53VK#88` | 0.015    | 0.05     | the spec loads `?iterations=2`; the page enables `enableDeviceLostSceneRecovery` so the second export keeps vertex colors (Scope)                                                                                                |
| 317   | Shared Buffer Conversions · `#KX53VK#85`                       | 0.015    | 0.05     | two meshes over one set of arrays                                                                                                                                                                                                |
| 318   | Morph Target Animation · `#84M2SR#107`                         | 0.0006   | 0.05     | the influence animations are not authored (the exporter exports only glTF-clip animation groups); the frame-60 weights are applied after the reload. Upstream excludes this test on WebGPU, but the WebGPU reference page passes |
| 319   | Rotation conversion, left-handed · `#UK7FLI#1`                 | 0.092    | 0.15     | Babylon.js's default material for material-less boxes is a Standard material, so the Lite boxes get `createStandardMaterial()`                                                                                                   |
| 320   | Export GLTF Extension KHR_texture_transform · `#20OAV9#15148`  | 0.0003   | 0.05     | `wAng` maps to `uAng` with the opposite sign; the light and camera join after the export (no node filter)                                                                                                                        |

Five of the 26 tests are ported, one per scene above. Merged (1 of 26):

- Negative World Matrix (left handed, once): its single export and reload is the first iteration of the "twice" test, against the same reference image. A winding error that a second round trip would undo fails the plumbing fixed-point gate on `NegativeScaleTest`, `Node_NegativeScale_01` and `MirroredDoubleSided`.

Not ported (20 of 26):

- Right-handed variants (8): Negative World Matrix (right handed, once / twice), KHR punctual light right-handed, Camera right-handed (once / twice), and the camera rotation animation tests RH → LH, RH → RH, LH → RH. Lite has no right-handed scenes.
- Skinning and Animation, and its right-handed twin (2): skins are out of scope.
- Camera, left-handed (once / twice) and camera rotation animation LH → LH (3): they export two or eight cameras from one scene into split viewports. A Lite scene has one camera and the exporter exports `scene.camera` only.
- Kept on `wip/gltf-export-parity-blocked`, with the blocker (7):
    - Morph Target Animation Group (`#T087A8#29`): the alien is skinned, so its reloaded pose differs (skins).
    - KHR draco mesh compression (`#F8BF8N#3`): the Lite render is MAD 0.63 off without export (mostly the normal-mapped face) and 0.81 with it, because tangents and vertex colors are dropped (CPU retention is out of scope). The Babylon.js WebGPU reference page also misses Babylon.js's own reference image by 3.2 % (limit 1.1 %) there.
    - KHR materials clearcoat (`#9N6CLU#23`): the snippet's DDS environment is gamma-space; Lite's DDS environment loader treats it as linear (MAD 54.5 with or without export).
    - KHR gpu instancing (`#1Q2BWN#10`): Lite renders TeapotsGalore's metallic PBR under a hemispheric light brighter than Babylon.js (MAD 5.92, identical with and without export).
    - KHR punctual light, left-handed (`#FLXW8B#27`): Lite PBR direct lighting without an environment is darker (MAD 2.36 without export, 2.77 with it) and Lite has no `FALLOFF_GLTF`; the exporter also clamps the snippet's 30-radian spot cone to a valid `outerConeAngle`.
    - un/compressed texture roundtrip (`#8NTR5X#8`): the KTX2 source comes back re-encoded as PNG (original image bytes are out of scope): MAD 0.85, against 0.0005 without export.
    - multimaterial with raw texture (`#KU72PX`): its 2×1 textures use nearest sampling, which the reload loses because no samplers are exported (MAD 5.6; 0.12 with nearest sampling).

## Deferred follow-up work

The following items are intentionally outside this exporter change. The Scope and Visual parity sections describe current behavior; this list records the work needed to extend it.

### Exporter and loader capabilities

- Add skin data retention to the loader and export glTF skins, joints, and inverse bind matrices.
- Retain texture sampler descriptors so clamp, mirror, and filtering settings survive export.
- Retain and pass through original encoded image bytes, and preserve morph-target names for `extras.targetNames`.
- Keep tangents, UV2, colors, and 16-bit indices on the CPU for loaded meshes without requiring device-loss recovery.
- Expose whether Standard `uvOffset` is active, and keep CPU geometry arrays in sync with partial GPU-only vertex updates.
- Record loader-root and camera-fixup identity at load time instead of inferring it from shape.
- Decide and implement multi-camera export; the current API exports only `scene.camera`.
- Retain target paths for natively authored animation groups so they can be exported.

### Loader and lifecycle fixes

- Accept valid GLB files without a BIN chunk.
- Guard `json.nodes` when loading documents that omit the property, so an empty-scene export can be loaded.
- Decide whether hand-posed bones are included in exported poses, how cloned skinned characters identify skins, and whether removing an animation group stops or disposes its updates.

### Deferred validation

- Port the remaining Babylon.js serializer visual tests when their exporter capabilities or renderer prerequisites are available; see the unported tests and blockers above.
- Add a glTF Validator gate for plumbing exports, allowing only the documented informational and generated-tangent warnings.
- Add bundle-size checks for exporter isolation and the export demo scene without changing existing ceilings.
- Add counterparts for the remaining Babylon.js skin round-trip, cached-texture, and morph-target-name unit assertions.

### Related renderer work

These are renderer prerequisites for blocked parity scenes, not exporter changes:

- Match PBR direct lighting without an environment and metallic PBR under a hemispheric light.
- Support gamma-space DDS environments and a glTF-equivalent light falloff mode.

### Open conformance notes

- Resolve the interaction between `KHR_materials_ior` and `KHR_materials_specular`, and whether to report the unrepresentable RGB tint of `_metallicReflectanceTexture`.
- Reconcile the reflectance loader's gamma-byte convention with glTF's sRGB curve, and the existing factor-fold policy for sRGB textures combined with `_gammaAlbedo` or legacy sheen's extra shader-side gamma decode.
- Export volume thickness from the intended texture channel and honor `thickness.min`.
- Determine whether spot `innerConeAngle` can be derived from Lite's exponent falloff.
- Review Standard-material alpha behavior for opacity maps, additive emissive, ambient occlusion, and diffuse alpha under BLEND.
- Validate non-finite material/geometry values and index ranges; handle meshes parented only to the camera fixup node.

---

## File Manifest

The only production file outside `export-gltf/` is `index.ts`; the other rows outside it are tests, lab pages, CI configuration and docs.

| File                                                                                             | Role                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `export-gltf/export-gltf.ts`                                                                     | entry, phase orchestration, JSON assembly                                                                        |
| `export-gltf/export-gltf-types.ts`                                                               | glTF 2.0 JSON interfaces (type-only)                                                                             |
| `export-gltf/export-context.ts`                                                                  | `ExportContext` and contract types, `createExportContext`, `attachExtension`, `snapshotExtras`, `cachedAccessor` |
| `export-gltf/export-handedness.ts`                                                               | mirror conversions, `L`, sign pattern, `Rotate180Y`, `rotTo`, winding rule, tolerances                           |
| `export-gltf/export-buffers.ts`                                                                  | `BufferBuilder`: bufferViews, accessors, alignment, min/max; component constants                                 |
| `export-gltf/export-glb.ts`                                                                      | GLB framing                                                                                                      |
| `export-gltf/export-nodes.ts`                                                                    | root collection and partitioning, traversal, TRS/matrix emission, extras, mesh grouping and dedup                |
| `export-gltf/export-geometry.ts`                                                                 | attributes, indices and width, modes, morph targets, zero-UV synthesis, GPU-only and skinned-mesh warnings       |
| `export-gltf/export-materials.ts`                                                                | dispatch, PBR core, Standard→MR, writer list and sweep, fold resolution                                          |
| `export-gltf/export-material-slots.ts`                                                           | PBR slot helpers: UV selection, slot capture, `_uv2Mask` bits, omission setters                                  |
| `export-gltf/export-textures.ts`                                                                 | slot capture and resolution, per-slot textureInfo                                                                |
| `export-gltf/export-images.ts`                                                                   | readback, decode blit, row order, channel ops, content dedup, PNG encode step                                    |
| `export-gltf/export-png.ts`                                                                      | PNG chunks, CRC-32, zlib via `CompressionStream`                                                                 |
| `export-gltf/export-cameras.ts`                                                                  | camera node, fixup detection and collapse, projections                                                           |
| `export-gltf/export-animations.ts`                                                               | `collectAnimatedNodes`, groups → animations, channel validation, conversion                                      |
| `export-gltf/ext/export-ext-lights-punctual.ts`                                                  | lights array, node placement, collapse, world placement                                                          |
| `export-gltf/ext/export-ext-instancing.ts`                                                       | thin instances → `EXT_mesh_gpu_instancing`                                                                       |
| `export-gltf/ext/export-ext-texture-transform.ts`                                                | textureInfo transform extension                                                                                  |
| `export-gltf/ext/export-ext-*.ts` (13 material writers)                                          | per-writer digests above                                                                                         |
| `index.ts`                                                                                       | root re-export of `exportSceneAsGlb`                                                                             |
| `docs/lite/architecture/00-overview.md`                                                          | index row for this document                                                                                      |
| `docs/lite/architecture/60-gltf-exporter.md`                                                     | this file: the one-shot architecture spec                                                                        |
| `tests/lite/unit/export-gltf/export-test-utils.ts`                                               | unit harness: fake WebGPU device, fake textures and meshes, scene builder, GLB parser                            |
| `tests/lite/unit/export-gltf/handedness.test.ts`                                                 | conversion math and winding rule                                                                                 |
| `tests/lite/unit/export-gltf/buffers-glb-png.test.ts`                                            | `BufferBuilder`, `computeMinMax`, GLB framing, CRC-32, PNG                                                       |
| `tests/lite/unit/export-gltf/geometry.test.ts`                                                   | geometry, indices, morph targets, skinned meshes, thin instances                                                 |
| `tests/lite/unit/export-gltf/nodes.test.ts`                                                      | root collection, transforms, mesh folding, extras, determinism                                                   |
| `tests/lite/unit/export-gltf/materials-pbr.test.ts`                                              | PBR core, UV states, slot mapping                                                                                |
| `tests/lite/unit/export-gltf/materials-standard.test.ts`                                         | Standard→MR conversion and UV mapping                                                                            |
| `tests/lite/unit/export-gltf/material-writers.test.ts`                                           | the 13 extension writers                                                                                         |
| `tests/lite/unit/export-gltf/images.test.ts`                                                     | readback paths, image identity, failures, container                                                              |
| `tests/lite/unit/export-gltf/bjs-ports.test.ts`                                                  | Babylon.js test ports over native scenes                                                                         |
| `tests/lite/unit/export-gltf/cameras-lights-animations.test.ts`                                  | cameras, lights, animations                                                                                      |
| `lab/lite/{scene,bundle-scene,babylon-ref-scene}N.html`, `lab/lite/src/{lite,bjs}/sceneN.ts`     | visual parity scenes 316–320: Lite page and Babylon.js reference page                                            |
| `tests/lite/parity/scenes/sceneN-gltf-export-*.spec.ts`                                          | visual parity specs                                                                                              |
| `reference/lite/sceneN-gltf-export-*/babylon-ref-golden.png`, `lab/public/thumbnails/sceneN.jpg` | goldens and gallery thumbnails                                                                                   |
| `scene-config.json`                                                                              | ids 316–320 with `maxMad` and `maxRawKB`                                                                         |
| `lab/package.json`                                                                               | `@babylonjs/serializers` dev dependency for the reference pages                                                  |
| `lab/lite/export-gltf-test.html`                                                                 | plumbing lab page                                                                                                |
| `lab/lite/src/export-gltf-test.ts`                                                               | `window.exportGltfTest`: round trip for assets and a native scene; single export of a GLB                        |
| `tests/lite/plumbing/export-gltf.spec.ts`                                                        | plumbing spec: 9 assets plus a native scene (idempotence), Babylon.js test ports over hand-built glTF documents  |
| `tests/lite/plumbing/export-gltf-helpers.ts`                                                     | triangle fixture, GLB building and parsing, accessor reads                                                       |
| `azure-pipelines.yml`                                                                            | adds `tests/lite/plumbing/export-gltf.spec.ts` to the CI plumbing job                                            |

_End of spec. Regeneration target: deterministic GLB output, pass-through fidelity for glTF-sourced geometry and transforms, pixel-exact images, the documented warnings at the boundary, and no production change outside `export-gltf/` except the root re-export._
