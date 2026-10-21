# glTF exporter — temporary work plan

> **Temporary tracking doc. Delete before merging.** It records how the overnight implementation run went, the judgment calls made without you, and the follow-up items that would have gone into the todo repo (which I could not find among the repos this session can reach).

## Branches

| Branch | Base | Contents |
| --- | --- | --- |
| `docs/gltf-exporter-architecture` | `prod` (`4ce7440`) | `docs/lite/architecture/60-gltf-exporter.md` plus its row in `00-overview.md` |
| `feat/gltf-exporter-implementation` | the docs branch | the exporter (`packages/babylon-lite/src/export-gltf/`), the `index.ts` re-export, tests, doc revisions made during implementation, and this file |

No PR was opened.

## Plan and status

- [x] Rescope the architecture doc: anything needing code outside `export-gltf/` is out of scope (Scope section).
- [x] Push the doc to `docs/gltf-exporter-architecture`.
- [ ] Pre-implementation doc review by independent agents (source accuracy, internal consistency and implementability, glTF/validator conformance); fix findings.
- [ ] Implement the module end to end.
- [ ] Unit tests (Vitest) for every rule the doc's unit table lists that can run without a GPU.
- [ ] Lint, typecheck, focused unit tests, `no-webgpu` import test.
- [ ] Post-implementation code review by independent agents; fix findings.
- [ ] Sync the doc with the code (the doc stays the one-shot spec).

## Judgment calls made without you

_(filled in as the run progresses)_

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

### Housekeeping

14. Stale v1 planning docs on `feat/gltf-export` (`requirements.md`, `prd.md`, `goals.md`, `53-gltf-exporter.md`) contradict the current spec; delete or archive them.
15. Parity scenes E-1 … E-24 and their goldens are specified but not created in this run (they need Babylon.js golden captures and CI).
