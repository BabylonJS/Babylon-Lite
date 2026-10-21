# Module: glTF 2.0 Exporter

> Package path: `packages/babylon-lite/src/export-gltf/`
>
> Behavioral reference: the Babylon.js glTF serializer (`@babylonjs/serializers` v9.30.0, released 2026-10-08; `master` @ `676f462`, 2026-10-14) wherever the two engines share a concept. Babylon.js test names, playground ids and `config.json` entries cited below are pinned to that commit. Every divergence is recorded in the Babylon.js Equivalence Map.

---

## Purpose

`exportSceneAsGlb` serializes a `SceneContext` into a single binary glTF 2.0 (`.glb`) `Blob`. The Blob holds one JSON chunk and one BIN chunk; images are embedded as bufferViews.

The exporter is the inverse of `loadGltf`. Round trips are a design goal. The exporter recognizes and removes the artifacts the loader inserts: the `__root__` conversion node, camera fixup nodes, and factor-baked 1×1 textures. As a result, `loadGltf → exportSceneAsGlb → loadGltf` reproduces the source structure, within the limits listed under Scope, and a second round trip is byte-identical to the first.

The module handles four concerns:

1. **Handedness.** Lite scenes are left-handed. glTF is right-handed, with CCW front faces and −Z-forward cameras and lights. For natively built content, the exporter bakes the conversion into vertex data, transforms, instance matrices and animation curves. glTF-loaded content still carries right-handed data under the loader's mirror root; the exporter detects it and passes it through unchanged.
2. **Material mapping.** `PbrMaterialProps` is already glTF-shaped, so PBR export inverts the loader's import mappings field by field. `StandardMaterialProps` is converted to metallic-roughness with the Babylon.js conversion formulas.
3. **Images.** Every image is read back from the GPU and encoded as PNG, so its pixels are exactly what Lite samples.
4. **Sharing.** Geometry, materials, images and accessors are deduplicated in the output, matching the sharing the loader and engine maintain at runtime.

### Scope

The module is a leaf. It reads existing scene, engine and loader state, and changes no code outside `packages/babylon-lite/src/export-gltf/` except the one root re-export of `exportSceneAsGlb` in `index.ts`. Capabilities that would need a change anywhere else are **out of scope** and listed below, with what the exporter does instead. The design decisions behind them are deferred. The module's own tests, parity scenes and documentation are part of the module and do not count as outside changes.

**Out of scope: needs a change outside `export-gltf/`**

| Capability                                                                                                                                      | Why it needs an outside change                                                                                                                                                                                 | What the exporter does instead                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skins                                                                                                                                           | `SkeletonData` keeps no joint list and no inverse bind matrices. Only animation state holds them, and only for assets that have animation groups, so recovering them reliably needs the loader to retain them. | A skinned mesh exports unskinned: its rest geometry, no `JOINTS_*` / `WEIGHTS_*`, no `skins`, with a warning. Joint nodes and the animation channels that target them still export.    |
| Texture sampling                                                                                                                                | WebGPU cannot read a `GPUSampler`'s settings back. Recovering them needs a lookup in the engine's sampler pool or a descriptor stored on `Texture2D`.                                                          | No `sampler` is emitted, so readers apply glTF defaults (repeat wrapping, implementation-chosen filtering). Clamp, mirror and nearest sampling are lost.                               |
| Original image bytes                                                                                                                            | The loader decodes encoded images and discards the bytes.                                                                                                                                                      | Every image is read back from the GPU and encoded as PNG. JPEG, WebP and KTX2 sources become PNG.                                                                                      |
| Morph-target names                                                                                                                              | The loader keeps none.                                                                                                                                                                                         | `extras.targetNames` is not emitted.                                                                                                                                                   |
| Tangents, second UV set, vertex colors and 16-bit index width of loaded meshes                                                                  | Only existing opt-ins keep these on the CPU: `enableDeviceLostSceneRecovery` (active at load) for all four, `enableGltfCpuTangents` for tangents. GPU vertex buffers cannot be read back.                      | Exported when an opt-in kept them; otherwise the attribute is omitted with a warning, and indices export as 32-bit.                                                                    |
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
- Compressed or quantized output (Draco, meshopt, `KHR_mesh_quantization`), sparse accessors, and `KHR_texture_basisu` / `EXT_texture_webp` / `EXT_texture_avif` output.
- `.gltf` + `.bin` output.
- Cameras other than `scene.camera`.
- Light names and spot `innerConeAngle`.
- Scene-level extras and morph-target tangent deltas.
- glTF `LINE_LOOP` / `TRIANGLE_FAN` modes, which the loader already draws as triangle lists.

## Public API Surface

### Entry point — `export-gltf/export-gltf.ts`

```typescript
/** Serialize a scene to a single binary glTF 2.0 (.glb) Blob.
 *
 *  Reads the scene's meshes, lights, camera, materials and animation groups.
 *  Image pixels are read back from the GPU and embedded as PNG.
 *  Resolves to a Blob of MIME type "model/gltf-binary". Treats the scene as
 *  read-only. Valid before or after registerScene, but after addToScene
 *  (parent links are set by addToScene). Under a null engine, textured
 *  slots are omitted (see Images). */
export async function exportSceneAsGlb(scene: SceneContext): Promise<Blob>;
```

Semantics:

- **Read-only.** The scene renders identically before and after the call. The exporter writes to no scene, mesh, material or texture field.
- **Complete capture.** The export includes every mesh, every point/directional/spot light, the scene camera, and every glTF-clip animation group. It also includes transform hierarchies that are referenced only by animation channels (see Root collection). There is no filter parameter; to filter, callers restructure the scene (`removeFromScene`) before exporting.
- **Current pose.** Node TRS, thin-instance matrices, morph weights, material values and texture pixels export as they are at call time. Everything read from the scene is read synchronously before the first `await`, and every texture readback is submitted in that same synchronous step, so animation that runs while the export is in flight cannot tear the result (see State Machine). One exception: the glTF animation controller never writes TRS to skin joints, to skinned-mesh nodes, or to their ancestors (`excludedNodeIndices` in `gltf-animation.ts`). Those nodes therefore always export their rest pose, and their animated pose travels only in the exported animations.
- **Deterministic.** Two calls on an unchanged scene, in the same runtime, resolve to byte-identical Blobs (see Determinism).
- **Errors.** Recoverable issues log `console.warn` and degrade as described in this document. The promise rejects only for the conditions listed in Warnings & Errors.
- **Concurrency.** Calls are independent. Every cache is per call.

### Internal contract types — `export-gltf/export-context.ts`

```typescript
/** Per-call state shared by every export module. Discarded when the call resolves. */
export interface ExportContext {
    readonly engine: EngineContext;
    /** The glTF document under construction. */
    readonly gltf: GltfDocument;
    readonly buffers: BufferBuilder;
    /** SceneNode | Mesh | LightBase | Camera → glTF node index. */
    readonly nodeIndex: Map<object, number>;
    /** Source material (after getMaterialSource) → glTF material index, per mesh UV state (see Materials). */
    readonly materialIndex: Map<Material, Map<UvState, number>>;
    /** GPUTexture → its mip-0 pixels in storage row order (tight RGBA8), read back once per call.
     *  Submitted during capture; null when the texture is unreadable. */
    readonly pixelCache: Map<GPUTexture, Promise<PixelData | null>>;
    /** Texture slots and 1×1 factor folds recorded during capture, resolved after readbacks settle. */
    readonly slots: PendingSlot[];
    readonly folds: PendingFold[];
    /** Callbacks that need resolved factors (unlit, spec-gloss); run in registration order after folds and slots resolve. */
    readonly afterResolve: (() => void)[];
    /** Content key (dimensions, row order, channel ops, FNV-1a of the bytes) → glTF image indices with that key. */
    readonly imageIndex: Map<string, number[]>;
    /** glTF image index → glTF texture index (one texture per image; samplers are out of scope). */
    readonly textureIndex: Map<number, number>;
    /** Typed-array identity → (conversion variant → accessor index). */
    readonly accessorIndex: Map<ArrayBufferView, Map<string, number>>;
    /** Primitive-list signature → glTF mesh index. */
    readonly meshIndex: Map<string, number>;
    readonly extensionsUsed: Set<string>;
    readonly extensionsRequired: Set<string>;
    /** Logs each distinct message once per call. */
    warn(message: string): void;
}

/** Tight RGBA8 pixels of one texture's mip 0, row 0 first (storage order). */
export interface PixelData {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/** Row order of an emitted image relative to texture storage (see Images). */
export type RowOrder = "storage" | "reversed";

/** How a mesh's second UV set exports (see Materials, "UV states"). */
export type UvState = "uv1" | "uv0" | "lost";

/** Where and how one material slot samples its texture. */
export interface SlotMapping {
    readonly texCoord: 0 | 1;
    readonly transform?: { readonly offset: [number, number]; readonly scale: [number, number]; readonly rotation: number };
    readonly rowOrder: RowOrder;
    /** Channels to invert (`v → 255 − v`) in the emitted image; Standard bump slots only. */
    readonly invert?: "r" | "rg";
}

/** A texture slot recorded during capture. Resolution writes `owner[key]` or leaves it unset. */
export interface PendingSlot {
    /** The JSON object that receives the textureInfo: a material, `pbrMetallicRoughness`, or an extension object. */
    readonly owner: Record<string, unknown>;
    /** Member name in `owner`, e.g. "baseColorTexture". */
    readonly key: string;
    /** glTF slot string used as the image `name`, e.g. "baseColorTexture" or "clearcoatTexture". */
    readonly slot: string;
    readonly texture: Texture2D;
    readonly mapping: SlotMapping;
    /** Extra textureInfo members (`scale` for normal textures, `strength` for occlusion). */
    readonly extra?: Record<string, number>;
    readonly materialName: string;
}

/** A 1×1 factor fold recorded during capture; its factor values are written at resolution. */
export interface PendingFold {
    readonly owner: Record<string, unknown>;
    readonly kind: "baseColor" | "metallicRoughness";
    readonly texture: Texture2D;
    /** The props' own factors, multiplied into the texel (see PBR core). */
    readonly factor: readonly number[];
    readonly materialName: string;
}

/** One accessor request. */
export interface AccessorDesc {
    readonly bufferView: number;
    readonly byteOffset?: number;
    readonly componentType: 5121 | 5123 | 5125 | 5126;
    readonly count: number;
    readonly type: "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4";
    readonly normalized?: boolean;
    readonly min?: number[];
    readonly max?: number[];
}

export interface BufferBuilder {
    addBufferView(bytes: ArrayBufferView, byteStride?: number, target?: 34962 | 34963): number;
    addAccessor(desc: AccessorDesc): number;
    /** Lays out every bufferView and returns the BIN payload (length 0 when nothing was added). */
    finalize(): Uint8Array;
}

/** One glTF material extension writer. Writers form a static ordered array in
 *  export-materials.ts. */
export interface MaterialExtensionWriter {
    /** glTF extension name, e.g. "KHR_materials_clearcoat". */
    readonly name: string;
    /** Runs during capture (synchronous). When the material carries this extension's state:
     *  attach `out.extensions[name]`, capture any texture slots through ctx, and return true.
     *  Returning true records the name in ctx.extensionsUsed. Values that depend on folded
     *  factors are written from an `ctx.afterResolve` callback. */
    write(ctx: ExportContext, material: PbrMaterialProps, out: GltfMaterial): boolean;
}
```

`exportSceneAsGlb` is the only public addition, re-exported by name from `packages/babylon-lite/src/index.ts` (root-only export map, pillar 4e). The contract types stay module-internal and are tagged `@internal`. Unit tests import them from the source modules directly, as other unit suites already do (for example `tests/lite/unit/gltf-interleave.test.ts`).

### glTF document typings — `export-gltf/export-gltf-types.ts`

The loader types the glTF JSON as `any`, so it has no schema typings to import. The exporter declares its own interfaces, covering only the members it writes: `GltfDocument`, `GltfAsset`, `GltfScene`, `GltfNode`, `GltfMesh`, `GltfPrimitive`, `GltfMaterial`, `GltfTextureInfo`, `GltfNormalTextureInfo`, `GltfOcclusionTextureInfo`, `GltfTexture`, `GltfImage`, `GltfCamera`, `GltfAnimation`, `GltfAnimationChannel`, `GltfAnimationSampler`, `GltfAccessor`, `GltfBufferView` and `GltfBuffer`. Member names and value types follow the glTF 2.0 JSON schema, and every member is optional except where the schema requires it. The file is type-only and contributes zero runtime bytes.

---

## Internal Architecture

### Design rules

- **Opt-in by import.** The exporter is reached only through `exportSceneAsGlb`. No module in `export-gltf/` runs code at import time, and there is no global registry: the extension writers are a static ordered list. Scenes without the import carry zero exporter bytes.
- **Read-only.** The exporter reads plain-data interfaces and mutates nothing. All conversions act on copies. Retained CPU arrays are often views into the loaded GLB buffer, so the exporter never writes to them. Engine-owned caches are not written either. GPU work is limited to texture readback, and every GPU object it creates is transient and destroyed before the call resolves.
- **Omit defaults.** Values equal to their glTF defaults are omitted (see the consolidated table). Materials, textures, images and cameras are emitted only when referenced.
- **Warn and continue.** Content outside the exportable set logs a `console.warn` and degrades to a defined fallback. The exporter throws only in the cases listed in Warnings & Errors.
- **Deterministic.** The same scene exports to a byte-identical GLB: stable traversal order, insertion-ordered maps, a fixed writer order, fixed JSON member order, and no time- or randomness-dependent output.
- **Leaf module.** Nothing outside `export-gltf/` changes except the root re-export (see Scope).
- **Approximate equality.** Throughout this document, `≈` means every component is within ε = 0.001.

### Inputs read from the scene

This table is the exporter's full input surface. Extending the exporter starts by adding a row here.

| Source                                                   | Fields read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SceneContext`                                           | `surface` (`surface.engine`, `surface.canvas`), `meshes`, `lights`, `camera`, `animationGroups`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SceneNode` (incl. `TransformNode`, `Mesh`, `LightBase`) | `name`, `children`, `parent`, `position` / `rotationQuaternion` / `scaling` (observable; read `.x .y .z [.w]`), `_localMatrix`, `_localMatrixLocked`, `metadata.gltf.extras`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Mesh`                                                   | the above, plus `material`, `_authoredSign`, `_topology`, `_primitive.topology`, `_flatNormal`, `_cpuPositions`, `_cpuNormals`, `_cpuTangents`, `_cpuUvs`, `_cpuUv2s`, `_cpuColors`, `_cpuGpuIndices`, `_cpuIndices`, `_gpu.tangentBuffer` / `uv2Buffer` / `colorBuffer` (presence only), `skeleton` (presence only), `morphTargets`, `thinInstances`                                                                                                                                                                                                                                             |
| `MorphTargetData`                                        | `targets[].positions`, `targets[].normals`, `weights`, `count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ThinInstanceData`                                       | `matrices`, `count`, `colors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Material`                                               | via `getMaterialSource`: `name`, `metadata.gltf.extras`, `_buildGroup._materialFamily` (through `getMaterialFamily`), and the per-family props below                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PbrMaterialProps`                                       | `baseColorTexture`, `baseColorFactor`, `alpha`, `alphaBlend`, `_alphaCutOff`, `doubleSided`, `metallicFactor`, `roughnessFactor`, `ormTexture`, `occlusionStrength`, `occlusionTexture`, `normalTexture`, `normalTextureScale`, `emissiveTexture`, `_emissiveColor`, `specGlossTexture`, `_unlit`, `_unlitColor`, `_clearCoat`, `_sheen`, `_iridescence`, `_anisotropy`, `_subsurface`, `_transmissive`, `_specularWeight`, `_metallicF0Factor` (only as the specular-weight fallback), `_metallicReflectanceColor`, `_metallicReflectanceTexture`, `_reflectanceTexture`, `_hasUvTx`, `_uv2Mask` |
| `StandardMaterialProps`                                  | `diffuseColor`, `alpha`, `specularPower`, `emissiveColor`, `diffuseTexture`, `diffuseCoordIndex`, `_emissiveTexture`, `_bumpTexture`, `bumpLevel`, `_ambientTexture`, `ambientCoordIndex`, `_opacityTexture`, `alphaCutOff`, `uvScale`, `uvOffset`, `_hasUvTx`, `backFaceCulling`, `disableLighting`                                                                                                                                                                                                                                                                                              |
| `Texture2D`                                              | `texture` (`format`, `usage`, `dimension`, `depthOrArrayLayers`), `width`, `height`, `invertY`, `_hasTx`, `_texCoord` (iridescence slots only); transform through `getTextureTransform`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PointLight` / `DirectionalLight` / `SpotLight`          | `lightType`, `name`, `parent`, `position`, `rotationQuaternion`, `direction` (directional, spot), `diffuse`, `intensity`, `range` (point, spot), `angle`, `exponent` (spot)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Camera` (`FreeCamera` / `ArcRotateCamera`)              | `name`, `worldMatrix`, `parent`, `fov`, `nearPlane`, `farPlane`, `viewport` (through `getEffectiveAspectRatio`), `ortho` (`halfHeight`, `left`, `right`, `top`, `bottom`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AnimationGroup`                                         | `name`, `_gltfMixer[0]` (the clip), `targetedAnimations[].target`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EngineContext`                                          | `_device` (readback; absent on a null engine), `VERSION` (generator string)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

State outside this table is not part of the input contract. The corresponding glTF output is absent, without a warning, unless a rule below says otherwise. Examples: `visible` (and therefore `KHR_node_visibility`), `AssetContainer.materialVariants`, `xmpMetadata`, clustered lights, environment and image-based lighting, fog, and additional `AssetContainer.cameras`.

### Module map

There is one module per glTF entity, plus helpers for concerns that cut across entities. Modules communicate only through the `ExportContext`. Entity modules import helpers, and the entry orchestrates.

```
export-gltf/
  export-gltf.ts                          entry: exportSceneAsGlb, root partitioning, JSON assembly
  export-gltf-types.ts                    glTF 2.0 JSON interfaces (type-only)
  export-context.ts                       ExportContext, MaterialExtensionWriter, warn helper
  export-handedness.ts                    LH↔RH math: positions, quaternions, matrices, winding rule
  export-buffers.ts                       BufferBuilder: bufferViews, accessors, alignment, min/max
  export-glb.ts                           GLB container framing → Blob
  export-nodes.ts                         node traversal, TRS/matrix emission, mesh grouping
  export-geometry.ts                      primitives, attributes, indices, morph targets, dedup
  export-materials.ts                     material dispatch, PBR core, Standard→MR, writer sweep
  export-textures.ts                      texture funnel, textureInfo
  export-images.ts                        readback, decode blit, row order, content dedup
  export-png.ts                           PNG encoder (CRC-32, zlib via CompressionStream)
  export-cameras.ts                       camera node and projection
  export-animations.ts                    animation groups → glTF animations
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

The 13 material writers are assembled into `const MATERIAL_EXTENSION_WRITERS: readonly MaterialExtensionWriter[]` in `export-materials.ts`, in this order: unlit → emissive-strength → clearcoat → sheen → iridescence → anisotropy → ior → specular → transmission → volume → dispersion → diffuse-transmission → spec-gloss. The order is part of the output contract: it fixes the `extensionsUsed` ordering and the order of `afterResolve` callbacks.

Internal imports are static. The tree-shaking boundary is the feature itself: scenes without the exporter import carry none of its bytes.

### `BufferBuilder` — `export-buffers.ts`

- `addBufferView(bytes, byteStride?, target?)` records a bufferView with a deferred `byteOffset` and returns its index. Identical inputs (same array identity, stride and target) return the same index.
- `addAccessor(desc)` records an accessor that references a bufferView index, with `componentType`, `count`, `type`, and optional `byteOffset`, `normalized`, `min` and `max`.
- `finalize()` orders bufferViews by descending alignment need (`byteLength % 4 === 0` → 4, `% 2 === 0` → 2, else 1; this is the Babylon.js packing rule). The sort is stable. It concatenates the views in that order with no padding, assigns offsets, and returns the BIN payload. The sort alone satisfies glTF's alignment rules: every view whose length is a multiple of 4 starts at a 4-aligned offset, and every view whose length is a multiple of 2 at a 2-aligned one. Every emitted vertex attribute, matrix and float array has a length that is a multiple of 4, as glTF's 4-byte vertex-attribute rule requires. All data targets `buffers[0]`. This matches Babylon.js.

`min`/`max` are computed per component, over the emitted (converted) data, for every `POSITION` attribute accessor, every morph-target `POSITION` accessor, and every animation input accessor. These are the places where the glTF specification requires them.

### Root collection and partitioning — `export-gltf.ts`

1. **Seed and walk.** Walk the `parent` chain upward from each of these seeds: every mesh in `scene.meshes`, every exportable light in `scene.lights`, the scene camera, and every animation-bound node (each `targetedAnimations[].target` of a `_gltfMixer` group that is defined). Collect the distinct topmost ancestors in first-encounter order: meshes first, then lights, then the camera, then animation targets. Seeding from bound targets keeps channel-only hierarchies in the export, such as an animated meshless `TransformNode` root.

    **Membership is defined by `parent`.** The `SceneNode.parent` setter does not update `children`, so the two can disagree:
    - A node listed in `X.children` belongs to `X` only while its `parent === X`. `removeFromScene` clears `parent` without editing the old parent's `children`, so a removed node stays listed but is skipped, together with its subtree.
    - A node whose `parent` is `X` but which is missing from `X.children` (code assigned `parent` directly) is recorded as an _extra child_ of `X` while walking each mesh or animation-target seed's chain, in first-encounter order.

    The depth-first sweep visits `X`'s qualifying `children` first, then its extras. Light and camera seeds record no extras; their own modules attach them.

2. **Partition.** Classify each collected root:
    - **Loader conversion root.** A root matches when all of the following hold:
        - it is a `TransformNode` with no geometry (no `_gpu`), and `_localMatrix` is unset;
        - `position ≈ (0,0,0)`, `rotationQuaternion ≈ identity`, `scaling ≈ (−1,1,1)`;
        - no `_gltfMixer` group binds it (it is not any `targetedAnimations[].target`).

        A matching root is **stripped**, and its children export in the **pass-through** state. This inverts `createTransformNode("__root__", 0,0,0, 0,0,0,1, −1,1,1)` in `load-gltf.ts`. The stripped root's `metadata.gltf.extras` (the loader's home for `asset.extras`) becomes `asset.extras`; when several stripped roots carry extras, the first in root order wins.

    - **Every other root** exports in the **converting** state. A loader root that the application parented under its own node is not a root, so it is not stripped: it exports as an ordinary node with scale `(−1,1,1)` inside the converting pass, which is geometrically exact (its glTF children are converted along with everything else).
3. **Export.** Each root set exports depth-first. Root node indices concatenate into `scenes[0].nodes`.

A per-pass `convert: boolean` flag rides on the recursion. Every spatial emission site (TRS, vertex data, instance matrices, camera and light orientation, animation samples) branches on it once.

Lights and cameras always export from their own seeds (Lights, Cameras) and attach to their parent's exported node. The glTF loader links them to their node only through `parent`. Native code may also list them in a `children` array (`addToScene` then sets their `parent`), so the depth-first sweep skips any child that is a light (`"lightType" in child`) or a camera (`"nearPlane" in child`).

When the camera's parent is fixup-shaped (see Cameras), the camera seed contributes no root. The camera attaches under the fixup node's parent only if that parent is exported through another seed; otherwise it exports from its world matrix as a parentless camera. This covers the loader's `<camera>_bakedNode`: a parentless node whose matrix already includes the root flip, which neither the converting nor the pass-through rule could emit correctly.

### Coordinate-system policy — `export-handedness.ts`

Lite is left-handed and column-major (module 21). glTF is right-handed and Y-up, with CCW front faces and −Z-forward cameras and lights. Converting passes bake a mirror across the YZ plane (negate X). Pass-through passes hold data that is already right-handed and emit it verbatim, which keeps load→export round trips byte-stable.

Let `C = diag(−1, 1, 1, 1)`, so `C⁻¹ = C`.

**Vertex data (converting passes).** On copied arrays, negate component 0 of every `POSITION`, `NORMAL` and `TANGENT` element, and of every morph position and normal delta. Renormalize `NORMAL` and `TANGENT` xyz; zero-length vectors are left as they are. Tangent w passes through. UVs and colors are untouched. Pass-through passes copy attribute bytes verbatim, with no renormalization.

**Translation.** `(x, y, z) → (−x, y, z)`.

**Rotation.** The change of basis `quat(C · mat(q) · C)` is the linear map `L(x, y, z, w) = (x, −y, −z, w)`, up to overall sign.

- _Static rotations_ (node TRS, instance rotations, light and camera nodes): apply `L`, make the result canonical with the Babylon.js sign pattern, then normalize. Pick the pivot component: when `x² + y² > 0.5`, the larger of |x| and |y|; otherwise the larger of |z| and |w|. Ties go to the later component (y over x, w over z), matching Babylon.js's strict `>` comparisons; exact ties are common, for example in 90° rotations. Then flip the whole quaternion's sign if the pivot is negative. Applied to the input, this gives: x-pivot `(|x|, −s·y, −s·z, s·w)`; y-pivot `(−s·x, |y|, s·z, −s·w)`; z-pivot `(−s·x, s·y, |z|, −s·w)`; w-pivot `(s·x, −s·y, −s·z, |w|)`, where `s = sign(pivot)`.
- _Animation rotation keys and CUBICSPLINE tangents:_ apply `L` only, with no sign canonicalization. A per-key sign flip would break hemisphere continuity between keys and corrupt spline tangents.

**Scale.** Unchanged.

**Matrices** (`_localMatrix` nodes): `M′ = C · M · C`.

**Rotate180Y.** `R(q) = q ⊗ (0, 1, 0, 0)`, which is `(x, y, z, w) → (−z, w, x, −y)`. This map is linear, so it applies to animation keys and tangents too.

**Direction to rotation.** `rotTo(d)` is the unit quaternion rotating `a = (0, 0, −1)` onto the normalized `d`. Set `q = (d.y, −d.x, 0, 1 − d.z)` and normalize it. When `1 − d.z < 1e−6` (d ≈ (0,0,1)), use `(0, 1, 0, 0)`.

### Winding order

glTF front faces are counter-clockwise in the data: a front triangle's geometric normal `(p₁ − p₀) × (p₂ − p₀)` points along its vertex normals, and readers flip culling under negative-determinant nodes. Lite's native generators wind the other way: `createPlane`'s first triangle has geometric normal +Z and vertex normal −Z. Lite renders those with `frontFace: "ccw"` under positive-determinant world matrices, and renders glTF data the same way under the loader's negative-determinant root. `Mesh._authoredSign` records which convention a mesh uses: −1 for glTF-loaded meshes (`load-gltf.ts`, `gltf-share.ts`; also the USD loader), and +1 or unset for native ones. Negating X flips the data's winding relative to its normals, so per primitive:

| Pass         | `_authoredSign` | Index order                                       |
| ------------ | --------------- | ------------------------------------------------- |
| converting   | `+1` / unset    | verbatim                                          |
| converting   | `−1`            | reversed: triangles are emitted as `(i₀, i₂, i₁)` |
| pass-through | `−1`            | verbatim                                          |
| pass-through | `+1` / unset    | reversed                                          |

That is, reverse exactly when `(_authoredSign ?? 1) === (convert ? −1 : +1)`. The loader's mirrored-node `frontFace: "cw"` stamp is render state and does not affect export.

Reversal happens on a copy. A triangle-strip primitive that requires a reversal throws `Triangle strip winding reversal is not implemented`. Point and line topologies emit verbatim.

---

### Scene & node export — `export-nodes.ts`

Depth-first per root set. For each `SceneNode`:

1. **Dedup.** `nodeIndex` maps each live object to one glTF node. Revisiting a node links the existing index into the current parent's `children`.
2. **Create.** Set `node.name` from `name` when it is non-empty. The loader's synthetic names (`node_<i>`, `gltf_mesh_<i>`) cannot be told apart from authored ones and export as names. Set `node.extras` from `metadata.gltf.extras` when present; this inverts the loader's extras promotion (`gltf-feature-extras.ts`).
3. **Transform.**
    - When `_localMatrix` is set, it is the node's local transform (`scene-node.ts`). That is either a glTF `matrix` node (locked, holding the JSON array) or the exact matrix `setParent` keeps, which can carry shear that TRS cannot represent. Let `M` be it.
        - Emit `node.matrix` (`C·M·C` in converting passes, verbatim in pass-through), omitted when ≈ identity, unless one of the next two cases applies.
        - When the node is an animation-channel target, glTF forbids `matrix`: emit the TRS of `decomposeMat4(M)`, converted per the policy.
        - When `M` is not TRS-decomposable (recomposing `decomposeMat4(M)` differs from `M` beyond ε), glTF-Validator rejects it (`NODE_MATRIX_NON_TRS`): emit the same TRS and log `Node "<name>" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.`
    - Otherwise emit TRS from `position` / `rotationQuaternion` / `scaling`, converted per the policy. Omit each component when it is ≈ its default (`[0,0,0]`, `[0,0,0,1]`, `[1,1,1]`). Exported rotations are normalized.
4. **Mesh assembly.** Only a non-`Mesh` `TransformNode` absorbs meshes. Its `Mesh` children fold into this node's glTF mesh, one primitive each and in child order. This inverts the loader, which attaches one Lite `Mesh` per glTF primitive under the node's TransformNode. A `Mesh` child folds only when all of these hold:
    - its TRS is identity and it has no `_localMatrix` and no children;
    - it agrees on `thinInstances.matrices` identity and `count`, or none (the loader shares one matrices array across a node's primitives);
    - it agrees on morph-target `count` and current `weights` values.

    These fences exist because `EXT_mesh_gpu_instancing` and `mesh.weights` are single-valued per node or mesh. Loader output always satisfies them. A child that fails a fence, a `Mesh` with a non-identity transform or with children, and a standalone `Mesh` root each become their own node with a single-primitive mesh.

    A folded mesh is recorded in `nodeIndex` against the absorbing node's index, so animation channels and light/camera attachment resolve to the holding node. `mesh.name` and the glTF mesh's `extras` come from the first contributing mesh that carries each; later contributors' values are ignored. The loader promotes the first of primitive, mesh or node extras onto each Lite mesh, by reference. A Lite mesh whose `metadata.gltf.extras` is the same object (`===`) as its parent node's came from the node, and does not count as mesh extras.

5. **Mesh dedup.** The primitive list is keyed by a signature: attribute accessors, index accessor, material, mode, morph-target accessors and weights, in order. An identical signature reuses the existing glTF mesh, so nodes that share loader-shared geometry and materials reference one mesh.
6. **Children** are written only when non-empty.

Nodes export regardless of `visible`; visibility is runtime presentation state.

---

### Geometry export — `export-geometry.ts`

#### Attributes

One glTF primitive is emitted per Lite `Mesh`, from the retained CPU arrays. Interleaved glTF meshes materialize tight copies through their lazy de-stride getters:

| glTF attribute | Source          | Type / componentType | Notes                                                                  |
| -------------- | --------------- | -------------------- | ---------------------------------------------------------------------- |
| `POSITION`     | `_cpuPositions` | VEC3 / FLOAT         | min/max on the emitted data                                            |
| `NORMAL`       | `_cpuNormals`   | VEC3 / FLOAT         | omitted when `_flatNormal === true`; renormalized in converting passes |
| `TANGENT`      | `_cpuTangents`  | VEC4 / FLOAT         | xyz like normals; w passes through                                     |
| `TEXCOORD_0`   | `_cpuUvs`       | VEC2 / FLOAT         | verbatim                                                               |
| `TEXCOORD_1`   | `_cpuUv2s`      | VEC2 / FLOAT         | when retained                                                          |
| `COLOR_0`      | `_cpuColors`    | VEC4 / FLOAT         | RGBA                                                                   |

- **Floats.** Retained colors are `Float32Array`: the loader normalizes integer sources and widens VEC3 colors to RGBA at load. Attribute emission is therefore float throughout.
- **Skinned meshes.** `JOINTS_*` and `WEIGHTS_*` are never emitted (see Skinned meshes).
- **Flat shading.** `_flatNormal` marks primitives that had no `NORMAL` in the source. Omitting the generated normals keeps them flat-shaded on reimport, as glTF requires.
- **Synthesized UVs.** A source primitive without `TEXCOORD_0` gets zero-filled UVs at load. There is no flag for this, so those UVs export.

**Retention gate.** `_cpuPositions`, `_cpuNormals`, `_cpuUvs` and `_cpuIndices` are always retained for glTF meshes. `_cpuTangents`, `_cpuUv2s`, `_cpuColors` and `_cpuGpuIndices` are retained only by existing opt-ins that were active at load time: `enableDeviceLostSceneRecovery` keeps all four, and `enableGltfCpuTangents` keeps tangents. The exporter adds no retention of its own (see Scope). When a mesh has a non-null `_gpu.tangentBuffer`, `uv2Buffer` or `colorBuffer` but no matching CPU array, the attribute is omitted and the exporter logs `Mesh "<name>" has <attribute> on the GPU only; exporting the mesh without it.` (the attribute is `tangents`, `a second UV set` or `vertex colors`).

**Stale CPU arrays.** The partial-update helpers (`updateMeshPositions` and its siblings, listed under Scope) write only the GPU buffers. The exporter cannot detect this and exports the CPU arrays, which hold the geometry from before those updates.

A mesh with no `_cpuPositions` logs `Mesh "<name>" has no retained CPU geometry; exporting its node without a mesh.` and contributes a transform-only node. A mesh with positions but no `_cpuNormals` (and no `_flatNormal`) omits `NORMAL`.

Accessors are cached per (typed-array identity, conversion variant). The variant encodes the pass kind and the winding flip. Each emitted array becomes one tightly packed bufferView, with `target` 34962 for attributes and 34963 for indices.

#### Indices and mode

- **Source.** Indices come from `_cpuGpuIndices` when retained, which preserves the 16- or 32-bit width. Otherwise they come from `_cpuIndices`, emitted as UNSIGNED_INT. The winding rule applies on a copy when a reversal is needed.
- **Non-indexed meshes.** Every loader- or factory-built mesh is indexed: glTF primitives without indices get loader-synthesized sequential indices. A hand-assembled mesh lacking both index arrays exports a non-indexed primitive (no `indices`). If such a primitive requires a winding reversal, the exporter synthesizes the flipped `(0, 2, 1, 3, 5, 4, …)` sequence, as UNSIGNED_SHORT when the vertex count is ≤ 65535 and UNSIGNED_INT otherwise. The sequence is cached through the standard accessor cache against the position array under a synthesized-index variant. A non-indexed strip that requires a reversal throws, like the indexed case.
- **`primitive.mode`** uses the glTF numeric modes, and is omitted when it is 4 (TRIANGLES, the default). It is resolved in this order:
    1. `Mesh._topology`, when set. Codes 1 (points), 2 (lines), 3 (line strip) and 4 (triangle strip) map to glTF modes 0, 1, 3 and 5. Today only `createLineSystem` sets this field (to 2).
    2. Otherwise `Mesh._primitive?.topology`. `"point-list"`, `"line-list"`, `"line-strip"` and `"triangle-strip"` map to 0, 1, 3 and 5.
    3. Otherwise mode 4.

    glTF `LINE_LOOP` and `TRIANGLE_FAN` sources cannot reappear: the loader draws them as triangle lists over the raw indices (as Babylon.js does), and that is what is exported.

- **Unmapped materials.** A material family outside the dispatch table leaves `primitive.material` unset, with a warning (see Materials).

#### Morph targets

A mesh with `morphTargets` emits `primitive.targets`, one entry per `morphTargets.targets[t]`:

- `POSITION`: VEC3 / FLOAT deltas from `positions`, verbatim in pass-through and with X negated in converting passes, with min/max.
- `NORMAL`: VEC3 / FLOAT deltas when `normals` is non-null, under the same rule.

The glTF mesh gets `weights` from the current `morphTargets.weights`. Accessors are dense. Targets sharing arrays share accessors through the standard cache. The loader keeps no tangent deltas and no target names, so neither is emitted (see Scope).

#### Thin instances — `ext/export-ext-instancing.ts`

A mesh with `thinInstances` (`count > 0`) attaches `EXT_mesh_gpu_instancing` to its node.

- **Matrices.** `matrices` is a `Float32Array`, or a `Float64Array` under a high-precision-matrix engine (values are downcast to float32 on emission). Instance `i` is at offset `16·i`, column-major per module 21. Only the first `count` instances are read; the array may have spare capacity.
- **Decomposition.** Instance matrices are node-local in Lite (`finalWorld = world × instanceMatrix`), which matches the extension. Each matrix is decomposed with `decomposeMat4`, which returns `{ translation, rotation, scale }`.
- **Attributes.** `TRANSLATION` (VEC3/FLOAT), `ROTATION` (VEC4/FLOAT, normalized) and `SCALE` (VEC3/FLOAT). Each is emitted only when some instance deviates from its identity value.
- **Conversion.** Converting passes convert instance translations and rotations with the static rules; scale passes through.
- **Mirrored instances.** A negative-determinant matrix decomposes to the canonical negative-Y-scale TRS (`decomposeMat4` folds the mirror into −Y). Mirrored instances therefore survive round trips canonically, but not sign-faithfully.
- **Colors.** `colors` (RGBA per instance) emits `attributes._COLOR_0` as VEC3/FLOAT, the Babylon.js convention for this attribute. Alpha is dropped; when some instance alpha is below 1, the exporter logs one warning per mesh: `Instance color alpha is not represented in _COLOR_0; exporting RGB.` The glTF loader does not retain instance colors, so this applies to natively built instances.

The extension is recorded in `extensionsUsed` only; it is optional by design.

---

### Material export — `export-materials.ts`

#### Dispatch

The exporter resolves `getMaterialSource(material)` first: a `MaterialView` only overrides render features, and props are read from its source. Materials dedupe by source identity through `materialIndex`. The family comes from `getMaterialFamily`:

| Family                            | Path                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `"pbr"`                           | PBR core mapping, then the writer sweep                                                                             |
| `"standard"`                      | Standard→metallic-roughness conversion                                                                              |
| `"node"`, `"shader"`, `undefined` | warning `Material "<name>" of family "<family>" is not mapped to glTF; exporting the primitive without a material.` |

Every emitted material carries `name` and `extras` when present. The writer sweep runs the fixed `MATERIAL_EXTENSION_WRITERS` order; a writer that returns true records its extension name.

#### UV states

A slot that samples the second UV set needs `TEXCOORD_1` on every primitive that uses the material, or glTF-Validator rejects the file (`MESH_PRIMITIVE_TOO_FEW_TEXCOORDS`). Which UV set Lite samples can also depend on the mesh, so each primitive has a **UV state**:

| UV state | Mesh condition                            | UV1-selected slots export as                                                                                                                                                                                                      |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"uv1"`  | `TEXCOORD_1` exports (`_cpuUv2s` present) | `texCoord: 1`                                                                                                                                                                                                                     |
| `"uv0"`  | no `_gpu.uv2Buffer`                       | PBR: `texCoord: 0`, because the PBR shader samples UV0 when the mesh has no UV2 buffer. The exception is a UV1 `occlusionTexture`, which Lite then does not sample at all; it is not exported. Standard: omitted, as in `"lost"`. |
| `"lost"` | a UV2 buffer on the GPU only              | omitted, with `Material "<name>" samples TEXCOORD_1, which mesh "<mesh>" does not export; exporting that mesh without its UV1 textures.`                                                                                          |

`materialIndex` holds one glTF material per (source material, UV state) actually used. A material none of whose slots selects UV1 has a single glTF material shared by all three states.

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

| glTF output                          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseColorTexture`                   | `baseColorTexture` through the texture funnel, unless it is 1×1: a 1×1 base color folds into the factor and emits no texture. The loader's factor bake is 1×1 (`rgba8unorm-srgb`, bytes `[linearToSrgbByte(rgb), 255]`; the factor's alpha lives only in `alpha` for BLEND and MASK materials); a genuine 1×1 image folds the same way and renders identically.                                                                                                                                                                                                                                                                                                                       |
| `baseColorFactor`                    | Let `f = baseColorFactor ?? [1,1,1,1]` and `α = alpha ?? 1`; the shader computes `sample.rgb × f.rgb` and `sample.a × f.a × α`. Without a fold: `[f.rgb, f.a × α]`. With a fold of texel `t` (rgb decoded with `srgbByteToLinear`, alpha = byte / 255): `[t.rgb × f.rgb, t.a × f.a × α]`. Omitted when ≈ `[1,1,1,1]`.                                                                                                                                                                                                                                                                                                                                                                 |
| `metallicFactor` / `roughnessFactor` | Let `m = metallicFactor ?? 1` and `r = roughnessFactor ?? 1`; the shader multiplies them into `orm.b` and `orm.g`. Without an ORM fold, `m` and `r`. With a fold of texel `t`: `m × t.b / 255` and `r × t.g / 255`. Each omitted at 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `metallicRoughnessTexture`           | `ormTexture`, unless it folds or the material has a `specGlossTexture` (the spec-gloss shader path takes roughness and metallic from that texture instead). A 1×1 `ormTexture` folds when its R byte is 255 or occlusion does not read it (`s = 0`, or a separate `occlusionTexture` is set); otherwise it exports as a 1×1 image, because glTF has no occlusion factor. The loader's bake is `[255, rough, metal, 255]`, so it always folds. Lite's ORM packing is glTF's (R occlusion, G roughness, B metallic). For occlusion-only sources the loader uses the occlusion image as `ormTexture`; it exports here too, because that is what Lite samples for roughness and metallic. |
| `occlusionTexture`                   | With `s = occlusionStrength ?? 1`: omitted when `s` is 0. Otherwise `occlusionTexture` when set and sampled (a separate UV1 occlusion image in the `"uv1"` state, or the loader's ORM carrier on UV0; see PBR slot mapping); else the unfolded `ormTexture`, sharing its image as glTF ORM assets do; else omitted. `strength` is `s` when ≠ 1 (the loader imports 1 or 0; glTF `strength` is not read at load). `texCoord` and the transform follow PBR slot mapping.                                                                                                                                                                                                                |
| `normalTexture`                      | `normalTexture`; `scale` is `normalTextureScale` when ≠ 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `emissiveTexture`                    | `emissiveTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `emissiveFactor`                     | From `_emissiveColor` with `m = max(r, g, b)`. When `m ≤ 1`, the color itself (omitted at `[0,0,0]`). When `m > 1`, `_emissiveColor / m`, and the emissive-strength writer emits `{ emissiveStrength: m }`; this inverts the loader's premultiplication. When `_emissiveColor` is unset and `emissiveTexture` is set, `[1,1,1]`, because the shader then applies the texture alone.                                                                                                                                                                                                                                                                                                   |
| `alphaMode` / `alphaCutoff`          | `_alphaCutOff > 0` → `"MASK"`, with the cutoff written when ≠ 0.5. Otherwise `alphaBlend === true` or `α < 1` → `"BLEND"`. Otherwise omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `doubleSided`                        | `doubleSided === true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Folds read their texel from the same readback as any image (4 bytes). Under a null engine the texel is taken as white, so the fold uses the props alone, and the exporter logs `1×1 factor texture for material "<name>" is not readable on this engine; exporting its factors without the texture.`

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

The Babylon.js Blinn-Phong conversion. Standard colors are gamma-space (the Standard shader uses `diffuseColor` raw), and Lite decodes them with the 2.2 power form used by the Babylon.js default path:

```
baseColorFactor = [linear(diffuseColor) × 0.5, alpha]      linear(c) = c^2.2 per channel
metallicFactor  = 0
roughnessFactor = SpecularPowerToRoughness(clamp(specularPower, 0, 1024))
    where t = (P / 1300)^0.333333
          roughness = CubicBezier(t; 1.0, 0.1, 0.1, 0.1)
          CubicBezier(t; p0,p1,p2,p3) = (1−t)³p0 + 3(1−t)²t·p1 + 3(1−t)t²·p2 + t³p3
```

Texture and flag mapping:

- `diffuseTexture` → `baseColorTexture`, with `texCoord` from `diffuseCoordIndex`.
- `_bumpTexture` → `normalTexture`, with `scale = bumpLevel` when ≠ 1, and channel inversion:
    - **Scale.** Lite's Standard shader writes `1 / bumpLevel` to its UBO and multiplies the surface normal by it before building the cotangent frame (`perturbNormal` in `shader/wgsl-helpers.ts`). The frame's tangent and bitangent are renormalized, so the perturbed normal is `normalize(T·x + B·y + N·z / bumpLevel)`, which equals glTF's `normalize(T·x·s + B·y·s + N·z)` with `s = bumpLevel`. Babylon.js writes `level` the same way. `.babylon` sources copy Babylon.js's `level` into `bumpLevel` verbatim.
    - **Frame.** `perturbNormal` negates both screen-space `dpdy` terms, so its frame is `(−T₀, −B₀)`, where `T₀`, `B₀` come from the plain derivative formula. The PBR cotangent frame that renders the reimported glTF (`pbr-template.ts`) is `(T₀, −B₀)`. The tangent therefore points the other way. A flipped bump slot (see Standard UV mapping) also negates the derivative of the V coordinate that `perturbNormal` sees, relative to the exported UVs.
    - **Inversion.** The exported normal image inverts its red channel (`r → 255 − r`), and also its green channel when the bump slot is flipped: `invert: "r"` or `"rg"` in its `SlotMapping`.
- `_emissiveTexture` → `emissiveTexture`, with `emissiveFactor` preset to `[1,1,1]`. A non-black `emissiveColor` overwrites `emissiveFactor`, converted gamma → linear (`c^2.2`), because the Standard shader adds it in gamma space. Babylon.js writes it unconverted.
- `_ambientTexture` → `occlusionTexture`, with `texCoord` from `ambientCoordIndex`.
- Alpha: `alphaCutOff > 0` → `"MASK"` plus the cutoff. Otherwise `alpha < 1` or an `_opacityTexture` → `"BLEND"`.
- `backFaceCulling === false` → `doubleSided: true`.
- `disableLighting === true` → the unlit writer attaches `KHR_materials_unlit`.

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
    - `A` is a rotation by `uAng`, then a scale, then an offset, which is exactly `KHR_texture_transform`. It emits as `rotation = uAng`; `scale = [sx·S_x, sy·S_y]` (UV0) or `[sx, sy]` (UV1); and `offset = M·O + [uOffset, vOffset]` (UV0) or `[uOffset, vOffset]` (UV1).

Components equal to their defaults are omitted.

On the shared path the renderer honors `uvOffset` only after `enableStandardUvOffset()`, and whether that ran is private to `standard-pipeline.ts`. The exporter always applies `uvOffset` (see Scope), so a material that sets it without the opt-in exports an offset that Lite did not render.

#### Extension writer digests

Each writer inverts the corresponding loader module. Triggers and default omissions mirror the loader's import defaults, so round trips converge.

| Writer                 | Trigger                                                                                                                                                       | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlit`                | `_unlit === true` (or Standard `disableLighting`)                                                                                                             | `KHR_materials_unlit = {}`. When `_unlitColor` is set, an `afterResolve` callback checks the resolved core `baseColorFactor`; when it was omitted, `_unlitColor` becomes the factor rgb. (The loader sets `_unlitColor` only when a base color image exists, to the factor's rgb.)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `emissive-strength`    | `max(_emissiveColor) > 1`                                                                                                                                     | `{ emissiveStrength: m }`, with the core factor normalized to peak 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `clearcoat`            | `_clearCoat?.isEnabled`                                                                                                                                       | `clearcoatFactor` = `intensity ?? 1` (omitted at 0). The loader imports a texture without a factor as intensity 1, so that state re-exports as an explicit factor 1. `clearcoatRoughnessFactor` = `roughness ?? 0` (omitted at 0). `clearcoatTexture` = `texture`, `clearcoatRoughnessTexture` = `roughnessTexture`, `clearcoatNormalTexture` = `bumpTexture` with `scale = bumpTextureScale` when ≠ 1. An `indexOfRefraction ≠ 1.5` and an F0 remap that is on (`useF0Remap !== false`; the runtime default is on, and the loader sets `false`) are outside this extension's schema; each logs a warning and the rest still exports.                                                                     |
| `sheen`                | `_sheen?.isEnabled`                                                                                                                                           | `sheenColorFactor` = `(color ?? [1,1,1]) × (intensity ?? 1)`, omitted at `[0,0,0]`; the loader imports with `intensity = 1`, so glTF-sourced materials round-trip exactly. `sheenRoughnessFactor` = `roughness` (omitted at 0). `sheenColorTexture` = `texture`. `sheenRoughnessTexture` = `roughnessTexture` when set, else `texture` when set: Lite reads packed sheen roughness from the color texture's alpha whenever no roughness texture exists, and re-referencing the texture preserves that on reimport. `albedoScaling` has no glTF field and is unread.                                                                                                                                       |
| `iridescence`          | `_iridescence?.isEnabled`                                                                                                                                     | `iridescenceFactor` = `intensity ?? 1` (omitted at 0), `iridescenceIor` = `indexOfRefraction` (omitted at 1.3), `iridescenceThicknessMinimum` / `Maximum` = `minimumThickness` / `maximumThickness` (omitted at 100 / 400; already in nanometres), `iridescenceTexture`, `iridescenceThicknessTexture`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `anisotropy`           | `_anisotropy?.isEnabled`                                                                                                                                      | `anisotropyStrength` = `intensity ?? 1` (omitted at 0). `anisotropyRotation` = `atan2(d[1], d[0])` with `d = direction ?? [1, 0]` (omitted at 0), which inverts the loader's `direction = [cos rot, sin rot]`. `anisotropyTexture` = `texture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ior`                  | `_subsurface?.refraction?.indexOfRefraction` set and ≠ 1.5                                                                                                    | `{ ior }`. The loader also creates `refraction` for an explicit 1.5; emitting nothing is equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `specular`             | any of: weight `w = _specularWeight ?? _metallicF0Factor ?? 1` ≠ 1, `_metallicReflectanceColor` ≠ white, `_metallicReflectanceTexture`, `_reflectanceTexture` | `specularFactor` = `w` when ≠ 1; `specularColorFactor` = `_metallicReflectanceColor` when ≠ white; `specularTexture` = `_metallicReflectanceTexture`; `specularColorTexture` = `_reflectanceTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `transmission`         | `_transmissive === true`                                                                                                                                      | `transmissionFactor` = `_subsurface.refraction.intensity` (omitted at 0), `transmissionTexture` = `_subsurface.refraction.texture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `volume`               | `_subsurface?.thickness?.useGlTFChannel === true`, or `_subsurface?.tint` set with no `thickness` (an attenuation-only source volume)                         | `thicknessFactor` = `thickness.max` when `thickness` is present, `thicknessTexture` = `thickness.texture`, `attenuationColor` = `tint.color` when ≠ white, `attenuationDistance` = `tint.atDistance` when set. The loader's synthesized no-absorption tint (`color ≈ white` with `atDistance === 1`) emits no attenuation fields, restoring the source's omitted form. (The loader substitutes 1 for an absent or zero `thicknessFactor`, so that state re-exports as 1.)                                                                                                                                                                                                                                 |
| `dispersion`           | `_subsurface?.refraction?.dispersion > 0`, with refraction and thickness present                                                                              | `{ dispersion: 20 / refraction.dispersion }`, the inverse of the loader's `20 / dispersion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `diffuse-transmission` | `_subsurface?.translucency` with `thickness.min === 0 && thickness.max === 0` (the loader's thin-surface marker)                                              | `diffuseTransmissionFactor` = `intensity ?? 1` (omitted at 0), `diffuseTransmissionTexture` = `intensityTexture`, `diffuseTransmissionColorFactor` = `color` when ≠ white, `diffuseTransmissionColorTexture` = `colorTexture`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `spec-gloss`           | `specGlossTexture` set                                                                                                                                        | `KHR_materials_pbrSpecularGlossiness` with: `diffuseTexture` = `baseColorTexture`, omitted when the core path folded a 1×1 base color into the factor; `specularGlossinessTexture` = `specGlossTexture`; `diffuseFactor` = the resolved core `baseColorFactor` when it is emitted, written by an `afterResolve` callback. `specularFactor` and `glossinessFactor` are omitted: with a spec-gloss texture, Lite's shader takes F0 from the texture's RGB and roughness from `1 − A`, and ignores both factors. The core path exports no `metallicRoughnessTexture` for this material and keeps the core factors (`metallicFactor 0`, `roughnessFactor`) as the fallback for readers without the extension. |

The specular weight is read exactly as the shader reads it. The loader's IOR path parks a normalized IOR-derived F0 in `_metallicF0Factor` but sets `_specularWeight = 1`, so an IOR-only material has `w = 1` and emits no `specularFactor`. Its specular path writes the specular factor to both fields, or deletes both when the factor is ≈ 1.

Loader losses the exporter cannot undo, listed so round-trip tests expect them:

- `diffuseFactor`, `specularFactor` and `glossinessFactor` on spec-gloss sources with a texture: the loader drops `diffuseFactor`, and the shader ignores the other two.
- `innerConeAngle` on lights.
- Light names.
- A diffuse-transmission layer on materials that also carry IOR, transmission or volume. The loader merges extension layers with a shallow `Object.assign`, so the dielectric `_subsurface` replaces the translucency one.
- glTF `occlusionTexture.strength`.

---

### Texture export — `export-textures.ts`

```typescript
/** Capture one material slot (synchronous). Records a PendingSlot and submits the
 *  texture's readback unless one is already in flight. Writes nothing to `owner`;
 *  resolution does. */
function captureTextureSlot(
    ctx: ExportContext,
    owner: Record<string, unknown>,
    key: string,
    slot: string,
    tex: Texture2D,
    mapping: SlotMapping,
    materialName: string,
    extra?: Record<string, number>
): void;

/** Resolve every captured slot, in capture order, after all readbacks have settled (synchronous). */
function resolveTextureSlots(ctx: ExportContext): void;
```

The material modules call `captureTextureSlot` for every slot, with the `SlotMapping` that PBR slot mapping or Standard UV mapping produces. Resolution, per pending slot in capture order:

- **Image.** The slot takes its texture's `PixelData`, applies `mapping.rowOrder` and `mapping.invert`, and inserts or reuses an image by content (see Images). When the pixels are null, the slot is omitted with the unreadable-pixels warning.
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

When no component is present, no extension object is written. Writing one records `KHR_texture_transform` in `extensionsUsed` (optional extension).

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

The exporter submits readbacks during capture, one per distinct `GPUTexture`, at the first slot or fold that needs one, and stores the promise in `pixelCache`. Each promise gets a rejection handler when it is created, so a failure never surfaces as an unhandled rejection; failures are reported by the settle step (State Machine). The procedure produces pixels in storage row order:

1. **Preconditions.**
    - If `engine._device` is absent (null engine), the result is null. Each slot that needs it is omitted with `Texture pixels for material "<name>" are not readable on this engine; exporting the material without that texture.`
    - If `dimension !== "2d"` or `depthOrArrayLayers > 1`, the result is null. The slot is omitted with `Texture for material "<name>" is not a single 2D image; exporting the material without that texture.`
2. **Direct copy.** If the format is `rgba8unorm`, `rgba8unorm-srgb`, `bgra8unorm` or `bgra8unorm-srgb` and `usage` includes `COPY_SRC`, copy mip 0 directly. glTF-loader raster images qualify: they are uploaded with `COPY_SRC`, unflipped, with `premultipliedAlpha: false` and `colorSpaceConversion: "none"`.
3. **Decode blit.** Otherwise, if `usage` includes `TEXTURE_BINDING`, blit mip 0 into a transient RGBA8 target of the same size (see Pipeline Configuration and Shader Logic), then copy the target. This covers textures created without `COPY_SRC`, and float and block-compressed formats. Textures without `COPY_SRC` include `loadTexture2D`, solid textures, and KTX2 (also when it comes from glTF `KHR_texture_basisu`). Otherwise the result is null, with the unreadable-pixels warning.
4. **Copy and map.** `copyTextureToBuffer` into a `MAP_READ | COPY_DST` staging buffer with `bytesPerRow = align(width × 4, 256)`, submit, then `mapAsync(GPUMapMode.READ)`.
5. **Repack and release.** Repack rows tight into an RGBA8 `PixelData`. For a direct copy of a `bgra8*` source, swap B and R; the decode blit already writes RGBA. Then destroy the staging buffer and any transient target.

**Row order and channel ops.** Each slot asks for `"storage"` or `"reversed"` rows (`SlotMapping.rowOrder`). In `"reversed"` order, row `r` of the image is storage row `height − 1 − r`. `invert` then applies `v → 255 − v` to the named channels. With the slot's texCoord and transform, this reproduces what Lite samples:

- glTF-loaded images (uploaded unflipped, with glTF V-down UVs) come back byte-faithful and upright in storage order.
- Raster textures uploaded with the default flip (`loadTexture2D` with `invertY = true`, on Lite's Y-up UVs) produce a vertically mirrored PNG in storage order, which samples identically under the exported UVs.
- PBR slots always use storage order. Standard slots follow "Standard UV mapping and row order" (Materials).

**Factor folds.** A 1×1 `baseColorTexture` or `ormTexture` that folds (PBR core) is read from the 4 bytes of its `PixelData` and produces no image. Any other 1×1 texture exports as a normal image.

**Content dedup.** Readback images dedupe by content in their emitted form. The key is `${width}x${height}:${rowOrder}:${invert ?? ""}:${fnv1a32(bytes)}`, hashed over the bytes after reordering and inversion. On a key match the bytes are compared, and a mismatch takes a fresh image. A new image is encoded to PNG once. This collapses the duplicate GPUTextures the loader creates for one source image: separate sRGB and linear uploads hold identical bytes, and so do per-sampler uploads.

**HDR clamp.** Float sources (`rgba16float`, `rgba32float`) are clamped to [0, 1] by the blit, with `Texture for material "<name>" has a floating-point format; exporting it clamped to 8 bits.`

**GLB placement.** Images are written as `{ mimeType: "image/png", bufferView }`, with `name` set to the glTF slot string through which the image was first exported (`"baseColorTexture"`, `"clearcoatTexture"`, …).

**PNG encoding** (`export-png.ts`) is dependency-free and worker-safe (no canvas, no DOM):

- The 8-byte signature.
- `IHDR`: width, height, bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0.
- One `IDAT`: the zlib stream of all scanlines, each prefixed with filter byte 0, produced by `new CompressionStream("deflate")` (the Compression Streams "deflate" format is the RFC 1950 zlib wrapper PNG requires).
- `IEND`.
- Chunk CRCs are CRC-32 (polynomial `0xEDB88320`), using a table built lazily on first use.

---

### Camera export — `export-cameras.ts`

`scene.camera`, when set, emits one `cameras[0]` entry plus a node reference. `cameras[0].name` is `camera.name` when non-empty. glTF-sourced cameras exist only when the asset was loaded with `enableGltfCameras()`; the loader names them from the camera definition, or `camera<i>`.

**Node placement.**

A camera's parent `F` is **fixup-shaped** when it is a `TransformNode` with no geometry, empty `children`, and `scaling ≈ (−a, a, a)` for a uniform `a > 0`. This is the scaffolding `gltf-feature-camera.ts` inserts (named `<camera>_fixup`; detection is by shape only). The loader sizes `a = 1/worldScale` to cancel inherited uniform scale. A fixup-shaped node never exports. The camera's **placement parent** `P` is:

- `F.parent`, when it exports through another seed (see Root collection); otherwise none;
- `camera.parent` when it is not fixup-shaped.

- **Pristine collapse.** When `F` is fixup-shaped with `position ≈ (0,0,0)` and `rotationQuaternion ≈ identity`, `P` exists, and the camera's transform relative to `F` (`world(F)⁻¹ · worldMatrix`) is ≈ the 180° yaw that `createFreeCamera((0,0,0), (0,0,−1))` leaves (rotation `diag(−1, 1, −1)`, zero translation): `node.camera` is written onto `P`'s exported node, with no other change to that node. This is the exact inverse of the import, so pristine round trips are stable.
- **Residual fixup.** When `F` is fixup-shaped but fails the other pristine conditions, the exporter logs `Camera fixup node "<F.name>" carries extra transform; exporting the camera as its own node.` and applies own-node placement under `P`. No transform is ever folded into `P`, because it is a source node that other content may reference.
- **Own node.** Otherwise the camera becomes its own node, as a child of `P`'s exported node, or as a scene root when there is no `P`. Let `R = multiplyMat4(invertMat4(world(P)), camera.worldMatrix)`, or `camera.worldMatrix` with no `P`. `world(P)` is `P.worldMatrix`, a lazy getter that is valid before `registerScene`. A singular `world(P)` logs `Camera parent "<name>" has a singular world matrix; exporting the camera as a scene root.` and drops `P`. Camera nodes never emit `scale`.
    - **Converting `P`, or no `P`.** `(t, q, s) = decomposeMat4(R)`. Emit `translation = (−t.x, t.y, t.z)` and `rotation = Rotate180Y(convert(q))`, where `convert` is the static quaternion rule. Lite cameras look along local +Z; glTF cameras look along −Z.
    - **Pass-through `P`.** Here `R` is expressed in `P`'s right-handed frame. `world(P)` includes the root flip (`det < 0`), while a camera that renders unmirrored in Lite has `det(camera.worldMatrix) > 0`, so `det(R) < 0`. Let `M` be `R` with its third column negated (`R · diag(1,1,−1)`). `(t, q, s) = decomposeMat4(M)`; emit `translation = t` and `rotation = q`, verbatim. When `det(R) > 0`, the camera's Lite view is mirrored relative to its parent, which glTF cannot represent: the exporter logs `Camera "<name>" has a mirrored view under its parent; exporting it unmirrored.` and emits the same decomposition (`decomposeMat4` folds the mirror into scale, which is dropped). For the pristine shape, `R = diag(a, a, −a)` gives `M = a·I`: identity rotation, zero translation, matching the collapse.

**Projection.**

| Case                 | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera.ortho` unset | `type: "perspective"`, `perspective: { yfov: fov, znear: nearPlane, zfar?, aspectRatio? }`. `zfar` is omitted when `farPlane ≥ 1e6`, restoring the glTF infinite form behind the loader's `1e6` sentinel. `aspectRatio` = `getEffectiveAspectRatio(camera, canvas.width, canvas.height)` with `canvas = scene.surface.canvas`; omitted when there is no canvas (null engine) or its height is 0.                                                                                                                                                                                                                                                                                                                                                              |
| `camera.ortho` set   | `type: "orthographic"`, `orthographic: { xmag, ymag, znear: nearPlane, zfar: farPlane }`. `xmag` = `(right − left) / 2` when both planes are non-null, else `halfHeight × aspectRatio`. `ymag` = `(top − bottom) / 2` when both are non-null, else `halfHeight`. The loader sets all four planes, so imported cameras always take the plane form. Under a null engine the `halfHeight` fallback has no aspect source: `xmag = ymag`, with `Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.` glTF orthographic projections are symmetric: when `left + right` or `top + bottom` differs from 0 by more than ε, the exporter logs `Orthographic camera "<name>" has off-center bounds; exporting a symmetric projection.` |

---

### Light export — `ext/export-ext-lights-punctual.ts`

Each `scene.lights` entry with `lightType` `"point"`, `"directional"` or `"spot"` emits a `KHR_lights_punctual` light. `"hemispheric"` has no punctual counterpart; it logs `Hemispheric light is not representable in KHR_lights_punctual; skipping.` and contributes nothing. Any other `lightType` logs `Light type "<type>" is not exported.`

**Light block.** Defaults are omitted, matching the extension schema and the loader's import defaults:

| Field                 | Source                                        | Written when                                         |
| --------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `name`                | `name`                                        | non-empty (the loader leaves glTF light names empty) |
| `type`                | `lightType`                                   | always                                               |
| `color`               | `diffuse`                                     | ≠ `[1,1,1]`                                          |
| `intensity`           | `intensity`                                   | ≠ 1                                                  |
| `range`               | `range` (point, spot only)                    | ≠ `Number.MAX_VALUE`                                 |
| `spot.outerConeAngle` | `angle / 2` (Lite stores the full cone angle) | ≠ π/4                                                |

A spot `exponent` ≠ 1 logs `Spot light exponent falloff is approximated by KHR_lights_punctual cone angles.` and export proceeds. `spot.innerConeAngle` is left at its schema default, the same resolution the loader applies on import.

**Node placement** inverts the loader, which parents each light to its glTF node with `position (0,0,0)` and `direction (0,0,−1)`:

- **Collapse.** The light attaches directly to its parent's exported node (`node.extensions.KHR_lights_punctual.light = i`) when the parent is exported, that node holds no light yet, and the light's local state is identity-like: `position ≈ (0,0,0)`, `rotationQuaternion ≈ identity`, and for directional and spot lights `direction ≈ (0,0,−1)`.
- **Dedicated node.** Otherwise the light gets its own node, a child of the exported parent or a new scene root. Its `translation` is `position`. For directional and spot lights its `rotation` is `rotationQuaternion ⊗ rotTo(direction)`, omitted when identity. Both go through the converting-pass rules when applicable.

`gltf.extensions.KHR_lights_punctual = { lights: [...] }` is written once any light emits. The extension is optional (`extensionsUsed` only).

---

### Skinned meshes

Skins are out of scope (see Scope): `SkeletonData` holds only the bone texture, the vertex joint and weight arrays and the rest palette, with no joint nodes and no inverse bind matrices. For each exported mesh with a `skeleton`, the exporter:

- emits its geometry without `JOINTS_*` / `WEIGHTS_*`, so the mesh renders its unskinned vertex data (for loaded assets, usually the bind pose) at its node's transform;
- emits no `skins` entry and no `node.skin`;
- logs `Mesh "<name>" is skinned; skins are not exported, so it exports without skinning.`

Joint nodes are ordinary `TransformNode`s. They export with the rest of their hierarchy, and animation channels that target them still export.

---

### Animation export — `export-animations.ts`

One glTF animation is emitted per `scene.animationGroups` entry that carries `_gltfMixer` (the loader-retained `[clip, NodeRest[], SkeletonBinding[]]` triple). It is named `group.name`; the loader's synthetic `animation_<i>` names export as-is. Groups without `_gltfMixer` (manual property-animation groups) log `Animation group "<name>" has no glTF-clip data; skipping.`

#### Clip contract

Only `_gltfMixer[0]` (the clip) is read. The read surface, from `animation/types.ts`:

```typescript
// animation/types.ts (existing) — read surface only
interface AnimationSampler {
    readonly input: Float32Array;
    output: Float32Array;
    interpolation: InterpMode;
}
interface AnimationChannel {
    samplerIdx: number;
    nodeIdx: number;
    path: TargetPath; /* + pointer-only writer fields */
}
interface AnimationClip {
    name: string;
    channels: readonly AnimationChannel[];
    samplers: readonly AnimationSampler[];
    duration: number;
    frameRate?: number;
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

Lite's clip model matches glTF, so export passes data through with no resampling or baking:

- **Channels.** `clip.channels[i]` resolves its target through `targetedAnimations[i].target`; the loader builds that array 1:1 with `clip.channels`. For node and weights channels, the target is the live `TransformNode` (for weights, the node holding the morphed meshes). `target.node` is the resolved node's exported index; for a folded mesh, this is the absorbing node's index. A channel whose target is undefined or not exported is dropped with `Animation channel target (node <nodeIdx>) is not in the exported scene; skipping channel.`
- **Pointer channels** (`PATH_POINTER`) resolve to load-time writer closures whose JSON pointers are not retained. Each logs `KHR_animation_pointer channel in "<name>" is skipped on export.`
- **Samplers** are emitted on first use by a surviving channel. `input` and `output` arrays are embedded verbatim and deduplicated by array identity. Input accessors carry min/max.
- **Converting-pass targets** get per-key conversion. For `translation`, X is negated on values and tangents. For `rotation`, the linear map `L` is applied to values and tangents. `scale` and `weights` pass through. (Clips never target a camera object: an imported animated camera collapses onto its animated source node, whose channels pass through.) Pass-through targets embed byte-identical data.
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

- **Node order:** the node sweep emits the collected roots in collection order (meshes → lights → camera → animation targets), each depth-first. Then the camera's own node, if it has one, and then dedicated light nodes in `scene.lights` order. Each of these is appended to its parent's `children`, or to `scenes[0].nodes` when it has no exported parent.
- **Array order:** first-emission order for every top-level array. bufferView byte order follows the stable alignment sort.
- **Extensions:** `extensionsUsed` / `extensionsRequired` use insertion order, which the fixed writer order makes stable.
- **JSON member order:** top-level members serialize in the fixed order `asset`, `extensionsUsed`, `extensionsRequired`, `extensions`, `scene`, `scenes`, `nodes`, `meshes`, `materials`, `textures`, `images`, `cameras`, `animations`, `accessors`, `bufferViews`, `buffers`. Nested objects are built with keys inserted in the order this document's tables list them.
- **No volatile data:** there are no timestamps or random identifiers. Byte identity is guaranteed within one runtime only. PNG IDAT bytes come from the runtime's `CompressionStream`, and browsers may decode the same JPEG or WebP source to slightly different pixels before readback. Across browser engines, readback image bytes can therefore differ, and with them the bufferView offsets and lengths in the JSON.

### Default-value omission (consolidated)

| Property                                                             | Omitted when                                     |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| node `translation` / `rotation` / `scale` / `matrix`                 | ≈ `[0,0,0]` / `[0,0,0,1]` / `[1,1,1]` / identity |
| `primitive.mode`                                                     | 4 (TRIANGLES)                                    |
| `baseColorFactor`                                                    | ≈ `[1,1,1,1]`                                    |
| `metallicFactor` / `roughnessFactor`                                 | 1                                                |
| `alphaMode`                                                          | OPAQUE                                           |
| `alphaCutoff`                                                        | 0.5                                              |
| `normalTexture.scale` / `occlusionTexture.strength`                  | 1                                                |
| textureInfo `texCoord`                                               | 0                                                |
| `emissiveFactor`                                                     | ≈ `[0,0,0]`                                      |
| `doubleSided`                                                        | false                                            |
| texture `sampler`                                                    | always (samplers are out of scope)               |
| light `color` / `intensity` / `range`                                | `[1,1,1]` / 1 / `MAX_VALUE`                      |
| `spot.outerConeAngle`                                                | π/4                                              |
| `perspective.zfar`                                                   | `farPlane ≥ 1e6`                                 |
| `perspective.aspectRatio`                                            | no canvas                                        |
| `KHR_texture_transform` `offset` / `scale` / `rotation` / `texCoord` | `[0,0]` / `[1,1]` / 0 / 0                        |
| animation `interpolation`                                            | LINEAR                                           |
| extension factor defaults                                            | per the writer digests                           |
| top-level arrays / `scene` / `buffers`                               | empty                                            |

### Warnings & errors (consolidated)

**Thrown** (promise rejection):

- a winding reversal required on a triangle-strip primitive (thrown during capture);
- a GPU readback failure (`mapAsync` rejection, for example on device loss), reported after every other readback has settled and every transient GPU object has been destroyed.

Everything else degrades.

**Warn and continue** (message → consequence):

- **Nodes and geometry:** sheared local matrix → nearest TRS · no retained CPU geometry → node without mesh · attribute on the GPU only → attribute omitted.
- **Materials:** unmapped material family → primitive without material · UV1 textures on a mesh without exported `TEXCOORD_1` → those slots omitted · unreadable 1×1 factor texel → factors without the texture · clearcoat IOR or F0 remap → field skipped.
- **Textures and images:** unreadable texture pixels (null engine, or no `COPY_SRC` and no `TEXTURE_BINDING`) → slot omitted · non-2D texture → slot omitted · floating-point texture → clamped to 8 bits.
- **Lights:** hemispheric light → skipped · unknown light type → skipped · spot exponent ≠ 1 → falloff approximated.
- **Skins and instances:** skinned mesh → exported unskinned · instance color alpha → RGB only.
- **Cameras:** fixup with residual transform → camera as its own node · mirrored view under a pass-through parent → exported unmirrored · singular camera parent → camera as a scene root · null-engine orthographic aspect → `xmag = ymag` · off-center orthographic bounds → symmetric projection.
- **Animations:** property-animation group → skipped · pointer channel → skipped · channel target outside the export → channel dropped.

Each distinct message logs once per call.

---

## Pipeline Configuration

The exporter creates one transient render pipeline, used only by the decode blit (Readback, step 3). It is created per call and released with the call. Nothing is cached at module level, which satisfies the zero-side-effect rule without the device-change invalidation a persistent cache would need.

| State             | Value                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind group layout | binding 0: `texture`, `sampleType: "unfilterable-float"`, `viewDimension: "2d"`, visibility FRAGMENT. Any float-sampled format, including filterable ones, can bind as unfilterable-float. No sampler is used. |
| Source view       | `tex.texture.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 })`                                                                                        |
| Vertex stage      | fullscreen triangle from `vertex_index`, no vertex buffers                                                                                                                                                     |
| Fragment target   | `rgba8unorm-srgb` when the source format ends in `-srgb`, else `rgba8unorm`                                                                                                                                    |
| Primitive         | `triangle-list`, no culling                                                                                                                                                                                    |
| Depth / stencil   | none                                                                                                                                                                                                           |
| Blend             | none (replace)                                                                                                                                                                                                 |
| Target texture    | same width and height as mip 0, `usage: RENDER_ATTACHMENT \| COPY_SRC`, destroyed after readback                                                                                                               |
| Render pass       | one color attachment, `loadOp: "clear"`, `storeOp: "store"`                                                                                                                                                    |

Matching the target's color space to the source is what keeps sRGB content byte-stable. Sampling an `-srgb` source returns linear values, and writing to an `-srgb` target re-encodes them, so the stored bytes come back as the source's stored bytes. A linear target would store linear values and produce a dark PNG.

Integer, depth and stencil formats are not float-sampled. They fail the `TEXTURE_BINDING` float precondition and take the unreadable-pixels warning.

## Shader Logic

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;

struct V { @builtin(position) p: vec4f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[i];
    return V(vec4f(p, 0, 1));
}

@fragment fn fs(v: V) -> @location(0) vec4f {
    // Exact texel copy: one fragment per target texel, no filtering.
    return clamp(textureLoad(src, vec2i(v.p.xy), 0), vec4f(0), vec4f(1));
}
```

`textureLoad` at the fragment's integer pixel coordinate copies texel `(x, y)` to `(x, y)`, keeping storage row order. Row reversal, when required, happens on the CPU during repack. The clamp makes the float-to-8-bit conversion explicit. Inline WGSL follows the repo's minimal-whitespace convention (pillar 4).

## State Machine / Lifecycle

`exportSceneAsGlb` runs in five phases with no persistent state. Phase 1 is fully synchronous: it reads every piece of scene state the export uses, so nothing the render loop changes during the later `await`s can reach the output.

1. **Capture** (synchronous).
    1. Create the `ExportContext` (`engine = scene.surface.engine`) with the document root `{ asset: { generator: "Babylon Lite v" + VERSION, version: "2.0" } }` and empty arrays and caches.
    2. Collect and partition roots, recording extra children for parent-only links; record `asset.extras` from the first stripped root that carries extras.
    3. Node sweep: `export-nodes.ts` recurses depth-first per root set. Nodes emit meshes (`export-geometry.ts`; geometry is copied into the BufferBuilder as it is emitted), and meshes emit materials (`export-materials.ts`). Materials write every non-texture member and call `captureTextureSlot` for each slot and fold. That records the pending slot and submits its readback, so the GPU copy is queued in this synchronous step too.
    4. Camera (`export-cameras.ts`), lights (`ext/export-ext-lights-punctual.ts`) and animations (`export-animations.ts`), in that order.
2. **Settle.** `await Promise.allSettled` over every `pixelCache` promise. If any rejected, destroy every remaining transient GPU object and reject with the first error in capture order.
3. **Resolve** (synchronous). Resolve folds in capture order: write the factor values, then apply their omission rules. Then `resolveTextureSlots`: write every textureInfo, or leave the slot unset when its pixels are null. Then run the `afterResolve` callbacks in registration order. Image and texture indices are assigned here, in capture order, so they never depend on GPU completion order.
4. **Encode.** Encode each new image to PNG (`export-png.ts`) and add its bytes as a bufferView, in image-index order.
5. **Assemble.**
    1. Build `extensionsUsed` / `extensionsRequired` from the context sets; the lights writer attaches `gltf.extensions.KHR_lights_punctual.lights`.
    2. `buffers.finalize()` produces the BIN payload; `buffers: [{ byteLength }]` is written only when it has bytes.
    3. Assemble only the non-empty top-level arrays. `scenes` and `scene: 0` are written only when at least one node exported. Members follow the fixed order (Determinism).
    4. `export-glb.ts` frames the JSON and BIN chunks and resolves the Blob.

GPU objects created by readbacks (staging buffers, blit targets, the blit pipeline) are destroyed before the promise settles, on both the success and the rejection path.

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

Serializer features with no Lite counterpart are absent from this module: `KHR_materials_coat`, `KHR_materials_fuzz`, `KHR_materials_volume_scatter`, `KHR_materials_diffuse_roughness`, the experimental `KHR_materials_openpbr` and its `OpenPBRMaterial` path, and `EXT_lights_area`. The seams above (writer list, inputs table, image sources) are where each would land.

---

## Dependencies

- **Math** (`math/`, exported from `index.ts`): `decomposeMat4(m): { translation, rotation, scale }` (folds a negative determinant into −Y scale), `multiplyMat4(a, b)`, `invertMat4(m): Mat4 | null`, `createQuatFromRotationMat4(m)`, `srgbByteToLinear(b)`. The conversion formulas in `export-handedness.ts` are self-contained. `Mat4` is a branded readonly type; raw arrays such as a glTF `_localMatrix` are cast.
- **Scene state:** the Inputs table, including the retained CPU arrays, `MorphTargetData`, `ThinInstanceData` and `AnimationGroup._gltfMixer`.
- **Engine:** `_device` for readback and the decode blit; `scene.surface.canvas` for the camera aspect; `VERSION` for `asset.generator`. A null engine is detected by an absent `_device`.
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

---

## Test Specification

Four layers, mapped onto TESTING.md's categories:

- Vitest unit tests over fabricated plain-data scenes (`tests/lite/unit/`).
- Playwright plumbing tests over real exports (`tests/lite/plumbing/`).
- A glTF-Validator gate that this module introduces.
- A visual parity suite adapted from the Babylon.js serializer's visualization tests.

Because Lite entities are plain data, unit-test stubs are object literals; no engine or GPU is required.

### Unit tests — Vitest, `tests/lite/unit/export-gltf/`

| Test                                                               | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| handedness: quaternion                                             | sign-pattern result ≡ ±`quat(C·mat(q)·C)` over randomized unit quaternions; the pivot is non-negative; exact ties pick y over x and w over z (90° rotations); `L` alone is used for animation keys                                                                                                                                                                                                                                                                                                                     |
| handedness: position / matrix                                      | negate X; `C·M·C` element for element                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| handedness: Rotate180Y / rotTo                                     | `(x,y,z,w) → (−z,w,x,−y)`; applied twice ≡ identity up to sign; `rotTo` maps −Z onto d, including the opposite case                                                                                                                                                                                                                                                                                                                                                                                                    |
| winding rule                                                       | the four policy cases, incl. a converted `createPlane` kept verbatim and a glTF mesh in a converting pass reversed; strip reversal throws; LINES/POINTS untouched; non-indexed reversal synthesizes `(0,2,1,…)` at the width the vertex count needs; glTF numeric modes from `_topology` and `_primitive.topology`                                                                                                                                                                                                     |
| root collection                                                    | meshes → lights → camera → animation-target order; an animated meshless `TransformNode` root exports; a `(−1,1,1)` root that is an animation target is not stripped; a loader root parented under an application node exports as a `(−1,1,1)` node in a converting pass; `__root__` extras → `asset.extras`; parent-only links become extra children; a node removed with `removeFromScene` (still listed in its old parent's `children`) is skipped; lights and cameras listed in `children` are skipped by the sweep |
| node transforms                                                    | ε-default TRS omitted; `_localMatrix` (locked and unlocked) emits `matrix`, verbatim in pass-through and converted in converting passes; a sheared matrix emits the nearest TRS with the warning; an animated node with `_localMatrix` emits TRS                                                                                                                                                                                                                                                                       |
| mesh grouping and dedup                                            | identity-TRS children fold into the parent's primitives; identical signatures share one mesh; fold fences (shared instance matrices, morph count and weights) split incompatible siblings; a `Mesh` with children never absorbs; folded meshes resolve through `nodeIndex` to the absorbing node                                                                                                                                                                                                                       |
| geometry                                                           | `_flatNormal` omits `NORMAL`; GPU-only tangents, UV2 and colors warn and omit; retained tangents, UV2, colors and 16-bit indices export at their retained width                                                                                                                                                                                                                                                                                                                                                        |
| Standard UV mapping                                                | shared path: material-wide flip from `isStandardUvInverted`, flipped offset `1 − S_y − O_y`, UV1 untransformed; per-texture path: per-texture flip, composed rotation/scale/offset; `uvOffset` applied on both paths                                                                                                                                                                                                                                                                                                   |
| Standard bump                                                      | red inverted always, green inverted on a flipped slot; checked by evaluating `perturbNormal` and the PBR cotangent frame on the same synthetic derivatives                                                                                                                                                                                                                                                                                                                                                             |
| PBR slot mapping                                                   | core-slot transforms only with `_hasUvTx`; each extension gate (group, per-texture, always, never) as tabled; UV1 from `_uv2Mask` bits and iridescence `_texCoord`; a UV1 occlusion texture exports with `texCoord: 1` and no transform, and not at all in the `"uv0"` state                                                                                                                                                                                                                                           |
| UV states                                                          | `"uv1"`, `"uv0"` (PBR remaps to UV0, Standard omits) and `"lost"` (omitted, warning) each get their own material only when the material selects UV1                                                                                                                                                                                                                                                                                                                                                                    |
| Standard→MR                                                        | base color = `linear(diffuse) × 0.5`; roughness at P = 64 (0.328809, the Babylon.js conversion test's expected value) and at the 0 / 256 / 1024 clamp boundaries; texture slot mapping incl. `normalTexture.scale = bumpLevel` (checked against `perturbNormal`'s output for a sampled normal)                                                                                                                                                                                                                         |
| PBR core mapping                                                   | factor, texture, alpha and occlusion rules row by row, incl. occlusion-only and separate-occlusion loader shapes; unset `occlusionStrength` keeps occlusion; occlusion `texCoord` from `_uv2Mask` bit 32 (separate texture) or bit 2 (shared ORM)                                                                                                                                                                                                                                                                      |
| unset fields                                                       | every runtime-default row resolves before omission (e.g. unset anisotropy intensity exports strength 1; unset clearcoat `useF0Remap` warns; unset `_specularWeight` falls back to `_metallicF0Factor`)                                                                                                                                                                                                                                                                                                                 |
| alpha                                                              | factor alpha × `alpha` without a fold; × texel alpha with one                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1×1 folding                                                        | base color → sRGB-decoded texel × factor; ORM → G/B × factors; a 1×1 ORM with R < 255 and occlusion on exports as an image; no image emitted for folds                                                                                                                                                                                                                                                                                                                                                                 |
| emissive strength                                                  | `m ≤ 1` plain factor; `m > 1` normalized + strength; texture with unset `_emissiveColor` → `[1,1,1]`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| writers: unlit / ior / specular                                    | triggers and omissions; an IOR-only material emits no `specularFactor`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| writers: transmission / volume / dispersion / diffuse-transmission | `_transmissive` trigger; factor mapping; the synthesized tint omits attenuation; attenuation-only volume emits; `20 / strength` inverse; zero-thickness fence                                                                                                                                                                                                                                                                                                                                                          |
| writers: clearcoat / sheen / iridescence / anisotropy              | field mapping; sheen packed-roughness re-reference; `atan2` rotation inverse                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| writer: spec-gloss                                                 | extension payload without specular/glossiness factors; `diffuseFactor` from the resolved (folded) base color; MR fallback factors; no `metallicRoughnessTexture` and no readback for it                                                                                                                                                                                                                                                                                                                                |
| writer: unlit                                                      | `_unlitColor` becomes the factor only when the resolved core factor was omitted                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| texture transform                                                  | field mapping via `getTextureTransform`; rotation sign round-trips against a loader-imported reference; identity emits nothing                                                                                                                                                                                                                                                                                                                                                                                         |
| BufferBuilder                                                      | stable alignment sort, unpadded offsets satisfy component alignment, deferred patching, dedup, min/max                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GLB framing                                                        | magic, version, lengths, 0x20 / 0x00 padding, chunk types; a zero-length BIN chunk when empty                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PNG encoder                                                        | encode → `DecompressionStream("deflate")` inflate → pixel equality; CRCs; storage and reversed row order                                                                                                                                                                                                                                                                                                                                                                                                               |
| image dedup                                                        | identical pixel content from two GPUTextures → one image; a hash collision with different bytes → two images; the same pixels with different channel ops → two images; textures carry no `sampler` and no `samplers` array is written                                                                                                                                                                                                                                                                                  |
| capture                                                            | animating node TRS and morph weights while readbacks are pending does not change the output; one readback rejection rejects the call after the others settle, with no unhandled rejection                                                                                                                                                                                                                                                                                                                              |
| animations                                                         | sampler byte equality, numeric path table, interpolation mapping, CUBICSPLINE layout incl. converted tangents, input min/max, undefined-target drop, skip rules                                                                                                                                                                                                                                                                                                                                                        |
| skinned meshes                                                     | no `JOINTS_*` / `WEIGHTS_*`, no `skins`, no `node.skin`, the warning; joint nodes and their animation channels still export                                                                                                                                                                                                                                                                                                                                                                                            |
| thin instances                                                     | TRS decomposition, identity-attribute omission, `count` vs capacity, `_COLOR_0` and the alpha warning, negative-determinant canonical (−Y) round trip                                                                                                                                                                                                                                                                                                                                                                  |
| lights                                                             | block defaults, `outerConeAngle = angle/2`, collapse rule incl. the one-light-per-node fence, dedicated-node rotation, hemispheric and unknown-type skips                                                                                                                                                                                                                                                                                                                                                              |
| cameras                                                            | perspective `yfov` / `znear`, `zfar` omitted at the `≥ 1e6` sentinel, `getEffectiveAspectRatio` with a viewport, ortho plane form and `halfHeight` fallback (incl. null-engine `xmag = ymag`), off-center ortho warning, pristine fixup collapse and the residual → own-node refusal; converting own-node `Rotate180Y`; pass-through own-node `R · diag(1,1,−1)` with the mirrored-view warning; a fixup whose parent is not otherwise exported places the camera from its world matrix                                |
| null engine                                                        | textured slots omitted with the warning; 1×1 folds fall back to props; no `aspectRatio`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| empty scene                                                        | asset-only glTF (no `scenes`, no `buffers`) with a zero-length BIN chunk                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| metadata                                                           | node / mesh / material `extras` round trip; the first contributor wins on folded meshes; node extras shared by reference onto a mesh are not re-emitted as mesh extras                                                                                                                                                                                                                                                                                                                                                 |
| determinism                                                        | two exports of one scene are byte-identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| read-only                                                          | deep snapshots of every input object before and after export are equal                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Loader-convention invariants

These exporter rules each invert a specific loader convention. Each pair is kept honest by the listed tests:

| Invariant (loader convention ↔ exporter rule)                                                                                                           | Enforcing tests                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `uAng` stores glTF `rotation` verbatim ↔ re-emitted unchanged                                                                                           | texture transform (unit) · E-15                                   |
| native generators wind against their normals and glTF data with them, recorded by `_authoredSign` ↔ the winding table                                   | winding rule (unit) · sphere geometry (plumbing) · E-1            |
| `angle` stores the full cone ↔ `outerConeAngle = angle / 2`                                                                                             | lights (unit) · E-9                                               |
| 1×1 bakes: base color `rgba8unorm-srgb`, ORM `[255, rough, metal, 255]` ↔ factor folds                                                                  | 1×1 folding (unit) · E-17                                         |
| ORM packing R=occlusion / G=roughness / B=metallic ↔ `ormTexture` re-emitted as `metallicRoughnessTexture`                                              | PBR core mapping (unit) · E-17                                    |
| sheen roughness packed in the color texture's alpha ↔ `sheenRoughnessTexture` re-references `texture`                                                   | writers: sheen (unit) · E-20                                      |
| loader conversion root `(−1,1,1)` ↔ root stripping + pass-through state                                                                                 | root collection (unit) · no-root-conversion-node (plumbing) · E-1 |
| camera fixup `(−a, a, a)`, 180° yaw camera-local ↔ pristine fixup collapse                                                                              | cameras (unit) · E-10                                             |
| clip constants (`PATH_*` 0–4, `INTERP_*` 0–2) ↔ the clip-contract tables                                                                                | animations (unit) · E-3 / E-4                                     |
| Standard `perturbNormal` scales N by `1 / bumpLevel` before renormalizing ↔ `normalTexture.scale = bumpLevel`                                           | Standard→MR (unit) · E-24                                         |
| Standard `perturbNormal` frame `(−T₀, −B₀)` vs the PBR cotangent frame `(T₀, −B₀)` ↔ red (and, when flipped, green) inversion                           | Standard bump (unit) · E-24                                       |
| the loader uploads glTF images unflipped ↔ PBR slots read back in storage row order                                                                     | image dedup (unit) · E-16 · E-17                                  |
| no-`NORMAL` primitives flagged `_flatNormal` ↔ `NORMAL` omitted                                                                                         | geometry (unit) · E-14                                            |
| Standard flips UV0 slots by the material-wide orientation (shared path) or per texture (per-texture path), PBR does not ↔ per-slot row order and offset | Standard UV mapping (unit) · E-13 · E-24                          |

### Plumbing tests — Playwright, `tests/lite/plumbing/export-gltf*.spec.ts`

Each test builds or loads a scene, exports it, parses the Blob with the loader's GLB parser, and asserts structurally. Where marked, it reimports with `loadGltf(engine, blob)`. The Babylon.js `glTFSerializer.test.ts` suite maps as follows:

| Babylon.js integration test                                           | Status here                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| standard → metallic roughness / `_SolveMetallic`                      | ported to the unit layer (conversion + spec-gloss tests)                                                                              |
| empty scene → asset-only                                              | ported to the unit layer (structural; Lite's loader does not reload node-less documents)                                              |
| sphere geometry                                                       | ported: `createSphere` accessors, winding, min/max                                                                                    |
| translation / scale / rotationQuaternion / combined animations        | ported: clip groups round-trip channels and sampler bytes                                                                             |
| single-component translation animation                                | covered by the full-vector ports (Lite clips are full-vector)                                                                         |
| point / spot / directional / multiple lights                          | ported                                                                                                                                |
| scene and node metadata                                               | adapted: node / mesh / material extras at the unit layer; `SceneContext` carries no metadata, so scene-level `extras` is out of scope |
| instances share one mesh                                              | ported: shared geometry re-exports as one mesh, N nodes                                                                               |
| instances without their source mesh                                   | adapted: remove one sharing node before export                                                                                        |
| no root conversion node in output                                     | ported: `__root__` stripped, roots at top level                                                                                       |
| node animations targeting a meshless root (RH scene)                  | merged into the group form (Lite animations are clip groups)                                                                          |
| animation group targeting a meshless root (RH scene)                  | ported: group channel onto an empty `TransformNode`                                                                                   |
| shared texture not duplicated                                         | ported: one image, one texture, two materials                                                                                         |
| RH transforms unconverted                                             | ported: pass-through byte equality                                                                                                    |
| LH transforms consistently converted                                  | ported: against hand-computed references                                                                                              |
| children of unexported nodes reparented                               | adapted: `removeFromScene` before export is the filtering contract                                                                    |
| shared float `MatricesIndicesKind` conversion                         | not ported: skins are out of scope                                                                                                    |
| KTX2 → `KHR_texture_basisu`                                           | adapted: KTX2 sources export as blit-decoded PNG                                                                                      |
| WebP → `EXT_texture_webp`                                             | adapted: WebP sources export as PNG (source bytes are out of scope)                                                                   |
| KHR_interactivity export after final entity remapping                 | not ported: `KHR_interactivity` export is out of scope                                                                                |
| right-handed identity root preserved for KHR_interactivity references | not ported: `KHR_interactivity` export is out of scope                                                                                |

The Babylon.js unit suite `test/unit/glTF/glTFMaterialExporter.test.ts` ("NullEngine / cached texture path") covers cached-byte reuse, which is out of scope here; its null-engine cases map onto the unit layer's null-engine row. Its newer "material properties" block and `glTFExporter.test.ts` / `glTFAnimation.test.ts` / `glTFSkinsAndMorphTargets.test.ts` (master only) cover ground the unit rows above already cover.

Two gates run over every plumbing and parity output:

- **glTF-Validator** (`gltf-validator`, a new root dev dependency): zero errors and zero warnings. Information messages are allowed (for example `GLB_EMPTY_BIN_CHUNK` and `UNSUPPORTED_EXTENSION` for spec-gloss).
- **Round-trip idempotence:** `export(load(export(load(asset))))` is byte-identical to `export(load(asset))` for each parity source asset. The first export drops what is out of scope; after that, the output is a fixed point.

### Visual parity suite — Playwright, `tests/lite/parity/scenes/`

Each scene follows GUIDANCE §2's new-scene checklist: lab page and script, Vite input, parity spec, golden under `reference/lite/sceneN-<slug>/`, thumbnail, gallery card, bundle-size check, and a `scene-config.json` entry with `id`, `slug`, `name` and `maxMad`. Scene ids are allocated sequentially after the highest existing id when each scene lands; slugs take the form `sceneN-export-<name>`. The E-numbers below are stable labels, not ids.

The export twist: the page builds or loads the source scene, calls `exportSceneAsGlb`, reimports the Blob with `loadGltf`, and renders the **reimported** scene against the golden. `?seekTime=` freezes animated scenes. Goldens follow GUIDANCE §2b/§2c: captured once from the Babylon.js render of the source scene and never regenerated at test time.

Adapted from the Babylon.js `"GLTF Serializer"` entries in `packages/tools/tests/test/visualization/config.json` (playground ids and reference images are kept as provenance):

| E#   | Scene                          | Babylon.js source (playgroundId · reference image)                                                                                    | Adaptation                                                                                                   |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| E-1  | `export-negative-world-matrix` | with Negative World Matrix, 4 variants (LH/RH × once/twice) — `#KX53VK#88` · `glTFSerializerNegativeWorldMatrix.png` (errorRatio 1.1) | natively built and glTF-loaded negative-scale hierarchies; single and double round trip                      |
| E-2  | `export-shared-buffers`        | Shared Buffer Conversions — `#KX53VK#85` · `glTFSerializerSharedBufferConversions.png`                                                | meshes sharing geometry with mixed conversion needs                                                          |
| E-3  | `export-skinning-animation`    | Skinning and Animation (+RH) — `#DMZBX1#1/2` · `gltfSerializerSkinningAndAnimation.png`                                               | deferred until skins are in scope                                                                            |
| E-4  | `export-morph-animation`       | Morph Target Animation — `#84M2SR#107` · `gltfSerializerMorphTargetAnimation.png`                                                     | morphed mesh, weights channel                                                                                |
| E-5  | `export-morph-animation-group` | Morph Target Animation Group — `#T087A8#29` · `gltfSerializerMorphTargetAnimationGroup.png`                                           | group-driven weights, non-zero rest weights                                                                  |
| E-6  | `export-draco-source`          | KHR draco mesh compression — `#F8BF8N#3` · `glTFSerializerKhrDracoMeshCompression.png`                                                | Draco source asset: decoded at load, exported as plain accessors                                             |
| E-7  | `export-clearcoat`             | KHR materials clearcoat — `#9N6CLU#23` · `glTFSerializerKhrMaterialsClearcoat.png`                                                    | clearcoat factors and textures                                                                               |
| E-8  | `export-gpu-instancing`        | KHR gpu instancing — `#1Q2BWN#10` · `glTFSerializerKhrGpuInstancing.png`                                                              | thin instances → extension → thin instances                                                                  |
| E-9  | `export-punctual-lights`       | KHR punctual light LH/RH — `#FLXW8B#27` · `glTFSerializerKHRPunctualLightLH/RH.png`                                                   | native lights (converting) and glTF lights (pass-through)                                                    |
| E-10 | `export-camera`                | Camera, 4 variants (LH/RH × round trip once/twice) — `#O0M0J9#25` · `glTFSerializerCameraLeftHand/RightHand.png`                      | native camera and imported camera (`enableGltfCameras`) with fixup collapse; double round trip               |
| E-11 | `export-rotation-conversion`   | Rotation conversion LH — `#UK7FLI#1` · `glTFSerializerRotationConversionLH.png`                                                       | nested rotated nodes through the converting pass                                                             |
| E-12 | `export-camera-animation`      | camera rotation animation, 4 variants — `#3A00GJ#42` · `glTFSerializerCameraRotationAnimation.png`                                    | imported animated camera round trip (Lite scenes are single-handed, so one scene covers the surviving legs)  |
| E-13 | `export-texture-roundtrip`     | un/compressed texture roundtrip — `#8NTR5X#8` · `glTFSerializerTextureExport.png` (errorRatio 0.1)                                    | glTF PNG direct copy next to KTX2 blit-decode (repeat-wrapped content only, since samplers are out of scope) |
| E-14 | `export-multimaterial`         | multimaterial with raw texture — `#KU72PX` · `glTFSerializerMultimaterial.png`                                                        | multi-primitive node, distinct materials, pixels-sourced texture, a no-`NORMAL` primitive                    |
| E-15 | `export-texture-transform`     | Export GLTF Extension KHR_texture_transform — `#20OAV9#15148` · `exportGltfKHRTextureTransform.png`                                   | offset / scale / rotation / texCoord round trip                                                              |

Additional scenes, for exporter surface with no Babylon.js visual twin:

| E#   | Scene                            | Covers                                                                                                                                      |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| E-16 | `export-boombox`                 | the BoomBox asset; full PBR (tangents only with an opt-in); byte-stable geometry pass-through; carries the export demo's `maxRawKB` ceiling |
| E-17 | `export-flighthelmet`            | multi-mesh, multi-material, ORM sharing, occlusion texCoord                                                                                 |
| E-18 | `export-spec-gloss`              | spec-gloss re-emission and MR fallback                                                                                                      |
| E-19 | `export-glass`                   | ior + transmission + volume + dispersion                                                                                                    |
| E-20 | `export-material-extension-grid` | sheen, anisotropy, iridescence, unlit, emissive-strength spheres                                                                            |
| E-21 | `export-compressed-source`       | meshopt + quantized source, exported dequantized                                                                                            |
| E-22 | `export-vertex-colors`           | `COLOR_0` RGBA with vertex-alpha blending                                                                                                   |
| E-23 | `export-ortho-camera`            | orthographic bounds → `xmag` / `ymag`                                                                                                       |
| E-24 | `export-babylon-standard`        | `.babylon`-loaded Standard scene → MR conversion, incl. an `invertY` texture                                                                |

Export scenes run in CI like every other parity scene; there is no separate tier. Source assets for parity scenes are chosen so that what Scope leaves out (skins, non-repeat sampling, Standard `uvOffset` without the opt-in) does not change the rendered frame.

### Bundle-size tests

- **Isolation.** Scenes that do not import `exportSceneAsGlb` carry zero exporter bytes. Per-scene manifests match a build without the module. The module changes no code that unrelated scenes fetch.
- **Ceiling.** The export demo scene (E-16) carries the `maxRawKB` ceiling on its `scene-config.json` entry. Ceiling changes follow §2 rule 9.

---

## File Manifest

Sizes are approximate. The only production file outside `export-gltf/` is `index.ts`; the other rows outside it are tests, docs and scene registration.

| File                                                    | Size              | Role                                                                                                      |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `export-gltf/export-gltf.ts`                            | ~190 lines        | entry, root partitioning, orchestration, JSON assembly                                                    |
| `export-gltf/export-gltf-types.ts`                      | ~170 lines        | glTF 2.0 JSON interfaces (type-only)                                                                      |
| `export-gltf/export-context.ts`                         | ~80 lines         | `ExportContext`, `MaterialExtensionWriter`, warn helper                                                   |
| `export-gltf/export-handedness.ts`                      | ~100 lines        | mirror conversions, `L`, sign pattern, `Rotate180Y`, `rotTo`, winding rule                                |
| `export-gltf/export-buffers.ts`                         | ~140 lines        | `BufferBuilder`: bufferViews, accessors, alignment, min/max                                               |
| `export-gltf/export-glb.ts`                             | ~60 lines         | GLB framing → Blob                                                                                        |
| `export-gltf/export-nodes.ts`                           | ~170 lines        | traversal, TRS/matrix emission, extras, mesh grouping and dedup                                           |
| `export-gltf/export-geometry.ts`                        | ~220 lines        | attributes, indices, modes, morph targets, accessor caching, GPU-only and skinned-mesh warnings           |
| `export-gltf/export-materials.ts`                       | ~270 lines        | dispatch, PBR core, Standard→MR, writer list and sweep                                                    |
| `export-gltf/export-textures.ts`                        | ~100 lines        | texture funnel, per-slot textureInfo                                                                      |
| `export-gltf/export-images.ts`                          | ~220 lines        | readback, decode blit, row order, channel ops, content dedup, 1×1 reads                                   |
| `export-gltf/export-png.ts`                             | ~70 lines         | PNG chunks, CRC-32, zlib via `CompressionStream`                                                          |
| `export-gltf/export-cameras.ts`                         | ~120 lines        | camera node, fixup collapse, projections                                                                  |
| `export-gltf/export-animations.ts`                      | ~150 lines        | groups → animations, channel resolution, conversion, skips                                                |
| `export-gltf/ext/export-ext-lights-punctual.ts`         | ~130 lines        | lights array, node placement, collapse                                                                    |
| `export-gltf/ext/export-ext-instancing.ts`              | ~90 lines         | thin instances → `EXT_mesh_gpu_instancing`                                                                |
| `export-gltf/ext/export-ext-texture-transform.ts`       | ~40 lines         | textureInfo transform extension                                                                           |
| `export-gltf/ext/export-ext-*.ts` (13 material writers) | ~30–70 lines each | per-writer digests above                                                                                  |
| `index.ts`                                              | 1 line            | root re-export of `exportSceneAsGlb`                                                                      |
| `package.json` (root)                                   | 1 line            | `gltf-validator` dev dependency                                                                           |
| `docs/lite/architecture/00-overview.md`                 | 1 line            | index row for this document                                                                               |
| `scene-config.json`                                     | 23 entries        | E-1 … E-24 parity scenes except the deferred E-3; E-16's entry carries the export demo `maxRawKB` ceiling |
| `tests/lite/unit/export-gltf/*.test.ts`                 | —                 | unit layer                                                                                                |
| `tests/lite/plumbing/export-gltf*.spec.ts`              | —                 | plumbing layer, validator and idempotence gates                                                           |
| `tests/lite/parity/scenes/sceneN-export-*.spec.ts`      | —                 | visual parity suite (E-1 … E-24, except E-3)                                                              |

_End of spec. Regeneration target: deterministic GLB output, pass-through fidelity for glTF-sourced geometry and transforms, pixel-exact images, the documented warnings at the boundary, and no production change outside `export-gltf/` except the root re-export._
