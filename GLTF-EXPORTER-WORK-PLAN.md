# glTF exporter — temporary work plan

> **Temporary tracking doc. Delete before merging.** It records how the implementation run went and holds the follow-up issue, ready to paste: the todo repo was not among the repos this session can reach.

## Branches

| Branch                              | Base               | Contents                                                                                                                                          |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/gltf-exporter-architecture`   | `prod` (`4ce7440`) | `docs/lite/architecture/60-gltf-exporter.md` plus its row in `00-overview.md`                                                                     |
| `feat/gltf-exporter-implementation` | the docs branch    | the exporter (`packages/babylon-lite/src/export-gltf/`), the `index.ts` re-export, tests, doc revisions made during implementation, and this file |

No PR was opened.

## Plan and status

- [x] Rescope the architecture doc: anything needing code outside `export-gltf/` is out of scope (Scope section).
- [x] Push the doc to `docs/gltf-exporter-architecture`.
- [~] Pre-implementation doc review by independent agents. Three reviewers started; all three hit the session usage limit before reporting. Rather than restart them, review moved to the implementation: every module was checked against the Lite source while writing it, and two post-implementation reviewers ran on the code (below).
- [x] Implement the module end to end (`packages/babylon-lite/src/export-gltf/`, 32 files) plus the root re-export in `index.ts`.
- [x] Unit tests: 451 Vitest tests (468 with the Babylon.js ports) in `tests/lite/unit/export-gltf/` (harness with a fake WebGPU device that supports both readback paths).
- [x] Plumbing round trips: `lab/lite/export-gltf-test.{html,ts}` + `tests/lite/plumbing/export-gltf.spec.ts`. Run locally against headless Chromium with SwiftShader WebGPU: 10 local assets + a native scene, all fixed points after one export. A wider scratch run (LittlestTokyo, bunny_rigged, Animation_SkinType_01, XmpMetadataRoundedCube, rock, rhs-x, nav_test, babylonBurster, bath_day) also passed. FlightHelmetKTX could not run here (the KTX2 decoder is fetched from a CDN the sandbox blocks).
- [x] glTF-Validator (run locally, not a repo dependency) over every exported file: 0 errors. Remaining warnings are `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` only, for meshes whose tangents were not retained (out of scope) or never existed in the source.
- [x] Lint, typecheck, `no-webgpu` import test.
- [x] Post-implementation code review by two independent agents (renderer-semantics fidelity; glTF conformance and robustness). Fixed: 17 behaviours (see the commit `fix(export-gltf): address code-review findings`); the rest are listed in the follow-up issue (§6) with the reason.
- [x] Sync the doc with the code (the doc stays the one-shot spec), then a final independent doc-vs-code review: every warning text, contract type and manifest entry matches; its remaining findings were fixed in code or doc (`fix(export-gltf): final doc/code consistency pass`). The final doc is on both branches.
- [x] Babylon.js test ports: every test in `serializers/test/unit/glTF/` and `test/integration/glTFSerializer.test.ts` now has a Lite counterpart under the same title, or a stated reason it has none (GLB-only API, no export options, or out of scope). The mapping is in the spec's "Babylon.js test ports" section. New files: `tests/lite/unit/export-gltf/bjs-ports.test.ts` (17 tests), `tests/lite/plumbing/export-gltf-bjs-ports.spec.ts` (18) and `tests/lite/plumbing/export-gltf-helpers.ts`, plus an `exportGlb` hook on the lab page. They found no exporter bugs. Divergences from Babylon.js are by design and documented: unused UVs are kept, a material-less mesh gets no default material, and a node cannot be left out of the export while its children stay.
- [x] Removed the never-built test plans (glTF-Validator gate, visual parity scenes, bundle-size tests) from the spec; they are in the follow-up issue below.
- [x] Bundle isolation: filtered builds of scene1, scene7, scene260 and scene269 contain no exporter code. The byte measurement step could not run here (its browser needs remote assets the sandbox blocks), so CI's bundle-size check is still the authority.

## Final state (verified at the end of the run)

- 468 unit tests pass; `no-webgpu` import test passes; `tsc` clean for the package, tests and lab; ESLint and Prettier clean on every touched file.
- Plumbing: 29/29 (`export-gltf.spec.ts` 11, all fixed points; `export-gltf-bjs-ports.spec.ts` 18). glTF-Validator (scratch run): 0 errors on the 22 round-trip exports.
- Nothing outside `export-gltf/` changed in production code except the one `index.ts` re-export.

## Follow-up issue (paste into the todo repo)

**Title:** glTF exporter (Babylon Lite): deferred features and follow-up tests

**Context.** `exportSceneAsGlb` landed on `alexchuber/Babylon-Lite` branch `feat/gltf-exporter-implementation` as a leaf module: nothing outside `packages/babylon-lite/src/export-gltf/` changes except the root re-export. Anything that would need code elsewhere was scoped out, and the exporter warns and degrades instead (spec: `docs/lite/architecture/60-gltf-exporter.md`, Scope). This issue collects those deferred decisions, plus the tests that were specified but not built.

### 1. Features to implement (each needs a change outside `export-gltf/`)

- [ ] **Skins.** Today a skinned mesh exports unskinned, with a warning. Options:
    - (a) A loader retention feature that keeps the source JSON/BIN and stamps the skin on each mesh.
    - (b) Read `SkeletonBinding.jointNodes` / `inverseBindMatrices` from `AnimationGroup._gltfMixer[2]`. Only works for assets that have animation groups.
    - (c) A small `skin` record on `SkeletonData`, written by `gltf-feature-skeleton.ts`. The cleanest long-term seam.

    Unblocks: the two Babylon.js skin round-trip unit tests and the Skinning and Animation visual test.

- [ ] **Sampler recovery.** Today no `sampler` is emitted, so clamp, mirror and nearest sampling are lost. Options:
    - (a) A reverse lookup in the sampler pool (parse the `getOrCreateSampler` key).
    - (b) Store the `GPUSamplerDescriptor` on `Texture2D` at creation. This also fixes `getTextureMetadata`, whose 2D sampler metadata is always undefined today.

    `_recoverySource.samplerDesc` already exists for some texture kinds when device-lost recovery is on, but not for glTF-loaded bitmaps.

- [ ] **Original image bytes (passthrough).** Today every image is read back from the GPU and written as PNG. Needs the loader to keep the encoded bytes or the source container. This would round-trip JPEG/WebP/KTX2 byte for byte and shrink exports. Unblocks: the three Babylon.js "NullEngine / cached texture path" unit tests.
- [ ] **Morph target names** (`extras.targetNames`). The loader has to keep them. Unblocks: the names assertion of the Babylon.js morph-target round-trip unit test.
- [ ] **CPU retention of tangents / UV2 / colors / 16-bit indices** for loaded meshes, without needing `enableDeviceLostSceneRecovery`.
- [ ] **Standard `uvOffset` gating.** Expose whether `enableStandardUvOffset()` is active, through a tiny `@internal` accessor in `standard-pipeline.ts`. Today `uvOffset` exports whenever it is set.
- [ ] **Partial vertex updates.** `updateMeshPositions` and its siblings write only the GPU, so the CPU arrays go stale. Decide whether these helpers should also update the CPU copy, or whether the exporter should read the GPU buffers back.
- [ ] **Loader root and camera fixup identity.** Use load-time markers instead of recognizing them by shape.

### 2. Loader bugs found while specifying

- [ ] `parseGlbContainer` throws on a valid GLB that has no BIN chunk.
- [ ] `load-gltf.ts` reads `json.nodes.length` without a guard, so documents without nodes fail to load. As a result, an empty-scene export does not reload in Lite.

### 3. Tests not built yet

- [ ] **Visual parity suite.** Port the Babylon.js "GLTF Serializer" visualization tests (`packages/tools/tests/test/visualization/config.json`) to Lite parity scenes.
    - Each scene builds or loads the source scene, exports it with `exportSceneAsGlb`, reimports the Blob with `loadGltf`, and renders the **reimported** scene against a golden captured once from Babylon.js. Animated scenes freeze with `?seekTime=`.
    - Each scene follows the GUIDANCE §2 new-scene checklist: lab page and script, Vite input, parity spec, golden under `reference/lite/sceneN-<slug>/`, thumbnail, gallery card, bundle-size check, and a `scene-config.json` entry with `maxMad`.
    - Needs: golden captures from Babylon.js and local or CI visual runs. Agent sessions may not run these without your explicit go-ahead.

    | #   | Lite scene                     | Babylon.js test · playground · reference image                                                                  | Adaptation                                                                                |
    | --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
    | 1   | `export-negative-world-matrix` | Negative World Matrix, 4 variants (LH/RH × once/twice) · `#KX53VK#88` · `glTFSerializerNegativeWorldMatrix.png` | natively built and glTF-loaded negative-scale hierarchies; single and double round trip   |
    | 2   | `export-shared-buffers`        | Shared Buffer Conversions · `#KX53VK#85` · `glTFSerializerSharedBufferConversions.png`                          | meshes sharing geometry with mixed conversion needs                                       |
    | 3   | `export-skinning-animation`    | Skinning and Animation (+RH) · `#DMZBX1#1/2` · `gltfSerializerSkinningAndAnimation.png`                         | blocked on skins (§1)                                                                     |
    | 4   | `export-morph-animation`       | Morph Target Animation · `#84M2SR#107` · `gltfSerializerMorphTargetAnimation.png`                               | morphed mesh, weights channel                                                             |
    | 5   | `export-morph-animation-group` | Morph Target Animation Group · `#T087A8#29` · `gltfSerializerMorphTargetAnimationGroup.png`                     | group-driven weights, non-zero rest weights                                               |
    | 6   | `export-draco-source`          | KHR draco mesh compression · `#F8BF8N#3` · `glTFSerializerKhrDracoMeshCompression.png`                          | Draco source decoded at load, exported as plain accessors                                 |
    | 7   | `export-clearcoat`             | KHR materials clearcoat · `#9N6CLU#23` · `glTFSerializerKhrMaterialsClearcoat.png`                              | clearcoat factors and textures                                                            |
    | 8   | `export-gpu-instancing`        | KHR gpu instancing · `#1Q2BWN#10` · `glTFSerializerKhrGpuInstancing.png`                                        | thin instances → extension → thin instances                                               |
    | 9   | `export-punctual-lights`       | KHR punctual light LH/RH · `#FLXW8B#27` · `glTFSerializerKHRPunctualLightLH/RH.png`                             | native lights (converting) and glTF lights (pass-through)                                 |
    | 10  | `export-camera`                | Camera, 4 variants · `#O0M0J9#25` · `glTFSerializerCameraLeftHand/RightHand.png`                                | native and imported camera (`enableGltfCameras`), fixup collapse, double round trip       |
    | 11  | `export-rotation-conversion`   | Rotation conversion LH · `#UK7FLI#1` · `glTFSerializerRotationConversionLH.png`                                 | nested rotated nodes through the converting pass                                          |
    | 12  | `export-camera-animation`      | camera rotation animation, 4 variants · `#3A00GJ#42` · `glTFSerializerCameraRotationAnimation.png`              | imported animated camera round trip (Lite scenes are single-handed)                       |
    | 13  | `export-texture-roundtrip`     | un/compressed texture roundtrip · `#8NTR5X#8` · `glTFSerializerTextureExport.png`                               | PNG direct copy next to KTX2 blit-decode (repeat-wrapped content until samplers exist)    |
    | 14  | `export-multimaterial`         | multimaterial with raw texture · `#KU72PX` · `glTFSerializerMultimaterial.png`                                  | multi-primitive node, distinct materials, pixels-sourced texture, a no-`NORMAL` primitive |
    | 15  | `export-texture-transform`     | Export GLTF Extension KHR_texture_transform · `#20OAV9#15148` · `exportGltfKHRTextureTransform.png`             | offset / scale / rotation / texCoord round trip                                           |

    Lite-only scenes, for exporter features that have no Babylon.js visual twin: BoomBox (full PBR, byte-stable geometry pass-through; carries the export demo's `maxRawKB` ceiling), FlightHelmet (multi-mesh, ORM sharing, occlusion texCoord), spec-gloss re-emission, glass (ior + transmission + volume + dispersion), a material-extension grid (sheen, anisotropy, iridescence, unlit, emissive strength), a meshopt + quantized source, vertex colors with vertex-alpha blending, an orthographic camera, and a `.babylon`-loaded Standard scene with an `invertY` texture.

    Choose source assets so that what is still out of scope (skins, non-repeat sampling, Standard `uvOffset` without the opt-in) does not change the rendered frame.

- [ ] **glTF-Validator gate.** Add `gltf-validator` as a root dev dependency and assert zero errors on every plumbing export.
    - Allowed: `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` warnings, and the info messages `UNUSED_OBJECT`, `NODE_EMPTY`, `GLB_EMPTY_BIN_CHUNK`, and `UNSUPPORTED_EXTENSION` for spec-gloss.
    - A scratch run over 22 exports during development found 0 errors.
- [ ] **Bundle-size checks.**
    - Isolation: scenes that don't import the exporter carry zero exporter bytes. A filtered build of scenes 1, 7, 260 and 269 confirmed this manually.
    - Ceiling: a `maxRawKB` ceiling on the export demo scene (the BoomBox scene above).

- [ ] **Babylon.js unit tests still without a Lite counterpart** (everything else in `serializers/test/unit/glTF/` is ported, see `tests/lite/unit/export-gltf/bjs-ports.test.ts` and `tests/lite/plumbing/export-gltf-bjs-ports.spec.ts`): the two skin round trips (needs skins), the three "NullEngine / cached texture path" tests (needs original image bytes), and the `extras.targetNames` assertion of the morph-target round trip (needs morph target names).

### 4. Open questions

- [ ] Bone-control poses: hand-posed bones (`enableBoneControl`) are not exported. Once skins exist, should "current pose" include them?
- [ ] Cloned skinned characters (`cloneTransformNode` shares the skeleton and morph targets): what are the skin identity rules once skins exist?
- [ ] Removing an animation group does not stop it ticking, and there is no dispose. Should export honor `removeFromScene`-style group removal?

### 5. Related findings (renderer, not the exporter)

- PBR `normalTextureScale` only takes effect when the template extension is active, i.e. with a UV transform, vertex colors or UV2 (`pbr-template.ts` ~314). Elsewhere Lite renders the normal map at scale 1.
- PBR `occlusionStrength` is applied only by the reflectance fragment. The base template uses `orm.r` at full strength.
- An iridescence texture on UV1 without any core `_uv2Mask` bit never enables `PBR2_HAS_UV2`.
- Light `range` is ignored under Lite's default physical falloff, but glTF viewers cut off at `range`.

### 6. Review findings deliberately not addressed

- Exact F0 interplay between `KHR_materials_ior` and `KHR_materials_specular`: Lite's loader lets the specular factor override the IOR-derived F0.
- `_metallicReflectanceTexture` RGB tint: glTF's `specularTexture` uses alpha only. Not representable, and there is no warning yet.
- Volume: thickness textures sampled from R (`useGlTFChannel` false) and `thickness.min` are not exported.
- Spot `innerConeAngle` could be derived from Lite's exponent falloff instead of being left at 0.
- Standard-material behaviour that glTF cannot express:
    - opacity-texture alpha, additive emissive, and the ambient texture used as occlusion;
    - diffuse-texture alpha under BLEND: Lite ignores it, glTF multiplies it in. A channel op that forces the exported diffuse alpha to 255 under BLEND would fix this one.
- No NaN/Infinity sanitization and no index range validation.
- A mesh parented (via `parent` only) to the scene camera's fixup node is dropped.

## Housekeeping (this branch, not for the issue)

- Stale v1 planning docs on `feat/gltf-export` (`requirements.md`, `prd.md`, `goals.md`, `53-gltf-exporter.md`) contradict the current spec; delete or archive them.
- The plumbing specs use the repo's Playwright config (`channel: "chrome"`); locally they ran under Chromium + SwiftShader via a scratch config. CI should pick them up like the other plumbing specs; worth confirming on the first CI run.
- History has `wip(...)` commits, and two of them (`a6319f8`, `d8bdf6f`) are mid-update states where unit tests fail; squash on merge.
- Delete this file before merging.
