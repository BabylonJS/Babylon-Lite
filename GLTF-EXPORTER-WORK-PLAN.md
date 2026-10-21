# glTF exporter — temporary work plan

> **Temporary tracking doc. Delete before merging.** It records how the overnight implementation run went, the judgment calls made without you, and the follow-up items that would have gone into the todo repo (which I could not find among the repos this session can reach).

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
- [x] Unit tests: 451 Vitest tests in `tests/lite/unit/export-gltf/` (harness with a fake WebGPU device that supports both readback paths).
- [x] Plumbing round trips: `lab/lite/export-gltf-test.{html,ts}` + `tests/lite/plumbing/export-gltf.spec.ts`. Run locally against headless Chromium with SwiftShader WebGPU: 10 local assets + a native scene, all fixed points after one export. A wider scratch run (LittlestTokyo, bunny_rigged, Animation_SkinType_01, XmpMetadataRoundedCube, rock, rhs-x, nav_test, babylonBurster, bath_day) also passed. FlightHelmetKTX could not run here (the KTX2 decoder is fetched from a CDN the sandbox blocks).
- [x] glTF-Validator (run locally, not a repo dependency) over every exported file: 0 errors. Remaining warnings are `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` only, for meshes whose tangents were not retained (out of scope) or never existed in the source.
- [x] Lint, typecheck, `no-webgpu` import test.
- [x] Post-implementation code review by two independent agents (renderer-semantics fidelity; glTF conformance and robustness). Fixed: 17 behaviours (see the commit `fix(export-gltf): address code-review findings`); the rest are listed under Follow-ups with the reason.
- [ ] Sync the doc with the code (the doc stays the one-shot spec).
- [x] Bundle isolation: filtered builds of scene1, scene7, scene260 and scene269 contain no exporter code. The byte measurement step could not run here (its browser needs remote assets the sandbox blocks), so CI's bundle-size check is still the authority.

## Follow-ups (would have been issues in the todo repo)

### Deferred design decisions (the out-of-scope list)

1. **Skins.** Options: (a) a loader retention feature that keeps the source JSON/BIN and stamps the skin per mesh; (b) read `SkeletonBinding.jointNodes` / `inverseBindMatrices` from `AnimationGroup._gltfMixer[2]`, which works only for assets that have animation groups; (c) a small `skin` record on `SkeletonData` written by `gltf-feature-skeleton.ts`. (c) is the cleanest long-term seam.
2. **Sampler recovery.** Options: (a) reverse lookup in the sampler pool (`getOrCreateSampler` key parse); (b) store the `GPUSamplerDescriptor` on `Texture2D` at creation (also useful for `getTextureMetadata`, whose 2D sampler metadata is currently always undefined). Note: `_recoverySource.samplerDesc` already exists for some texture kinds when device-lost recovery is on, but not for glTF-loaded bitmaps.
3. **Original image bytes (passthrough).** Needs the loader to retain encoded bytes or the source container. Would let JPEG/WebP/KTX2 sources round-trip byte-exact and shrink exports.
4. **Morph target names** (`extras.targetNames`): needs the loader to keep them.
5. **CPU retention of tangents / UV2 / colors / 16-bit indices** for loaded meshes without `enableDeviceLostSceneRecovery`.
6. **Standard `uvOffset` gating:** expose whether `enableStandardUvOffset()` is active (a tiny `@internal` accessor in `standard-pipeline.ts`).
7. **Partial vertex updates** (`updateMeshPositions` and siblings) leave CPU arrays stale; decide whether those helpers should also update the CPU copy, or whether the exporter should read GPU buffers back.
8. **Loader root / camera fixup identity:** load-time markers instead of shape sniffing.

### Loader bugs found while specifying

9. `parseGlbContainer` throws on a valid GLB without a BIN chunk.
10. `load-gltf.ts` reads `json.nodes.length` without a guard; node-less documents fail to load.

### Questions you raised earlier that are still open

11. Bone-control poses: hand-posed bones (`enableBoneControl`) are not exported; decide whether "current pose" should include them once skins exist.
12. Cloned skinned characters (`cloneTransformNode` shares skeleton and morph targets): decide skin identity rules once skins exist.
13. Removing an animation group does not stop it ticking and there is no dispose; decide whether export should honor `removeFromScene`-style group removal.

### Lite renderer quirks found by the review (Lite-side, not exporter changes)

16. PBR `normalTextureScale` only takes effect when the template extension is active (UV transform, vertex colors or UV2; `pbr-template.ts` ~314). Elsewhere Lite renders the normal map at scale 1. The exporter still exports the authored scale.
17. PBR `occlusionStrength` is applied only by the reflectance fragment (`mix(1, occ, strength)`); the base template uses `orm.r` at full strength. The exporter exports the authored strength.
18. An iridescence texture on UV1 without any core `_uv2Mask` bit never enables `PBR2_HAS_UV2`, so `input.uv2` may be missing in Lite.
19. Light `range` is ignored under Lite's default physical falloff, but exported (glTF viewers cut off at `range`).

### Review findings deliberately not addressed (judgment: low value or needs outside changes)

20. Exact F0 interplay between `KHR_materials_ior` and `KHR_materials_specular` (Lite's loader lets the specular factor override the IOR-derived F0).
21. `_metallicReflectanceTexture` RGB tint (glTF `specularTexture` uses alpha only) — not representable; no warning yet.
22. Volume: thickness textures sampled from R (`useGlTFChannel` false) and `thickness.min` are not exported.
23. Spot `innerConeAngle` could be derived from Lite's exponent falloff instead of left at 0.
24. Standard approximations that glTF cannot express: opacity-texture alpha, additive emissive, ambient texture as occlusion, diffuse-texture alpha under BLEND (Lite ignores it, glTF multiplies it in). A channel op that forces the exported diffuse alpha to 255 under BLEND would close the last one.
25. No NaN/Infinity sanitization and no index range validation; malformed geometry can still produce validator errors.
26. A mesh parented (via `parent` only) to the scene camera's fixup node is dropped.

### Housekeeping

14. Stale v1 planning docs on `feat/gltf-export` (`requirements.md`, `prd.md`, `goals.md`, `53-gltf-exporter.md`) contradict the current spec; delete or archive them.
15. Parity scenes E-1 … E-24 and their goldens are specified but not created in this run (they need Babylon.js golden captures and CI).
16. Add `gltf-validator` as a root dev dependency and run it in the plumbing spec (the local run used a scratch install).
17. The plumbing spec uses the repo's Playwright config (`channel: "chrome"`); locally it was run with Chromium + SwiftShader via a scratch config. CI should pick it up like the other plumbing specs — worth confirming on the first CI run.
