# Bundle-size follow-up

The consolidated change is based on master `639937f5`, after PR #736 merged.
It contains only the retained bundle work, not another copy of the matrix change.
Measurements count only runtime-fetched JavaScript, with the existing raw/gzip
accounting and unchanged scene ceilings. Historical matrix CPU measurements are
not reused as evidence for these changes.

## Final combined result against current master

The retained set comprises fragment-owned PBR constants, a single shader-binding
dispatch, consolidated Node pipeline descriptors, and opt-in graph-specific lazy
block loaders. All thirteen affected scenes shrink in both raw and gzip bytes.
The larger gains require selecting a fixed graph's blocks; the default loader
continues to support arbitrary graphs without a new opt-in requirement.

| Scene | Raw before | Raw after | Gzip before | Gzip after | Gzip saved |
| ----- | ---------: | --------: | ----------: | ---------: | ---------: |
| 1     |     89,208 |    89,022 |      38,485 |     38,435 |         50 |
| 2     |     45,480 |    45,341 |      18,985 |     18,976 |          9 |
| 7     |    106,169 |   105,981 |      46,302 |     46,264 |         38 |
| 28    |     87,397 |    87,209 |      36,994 |     36,942 |         52 |
| 29    |     91,267 |    91,083 |      39,165 |     39,112 |         53 |
| 62    |     57,805 |    52,375 |      25,278 |     23,662 |      1,616 |
| 66    |     88,908 |    85,874 |      43,550 |     42,666 |        884 |
| 72    |    108,413 |   108,219 |      45,921 |     45,867 |         54 |
| 88    |     57,818 |    50,788 |      26,709 |     24,350 |      2,359 |
| 140   |     91,907 |    91,243 |      45,030 |     44,831 |        199 |
| 141   |    114,458 |   113,660 |      50,865 |     50,699 |        166 |
| 149   |    102,288 |    96,703 |      43,652 |     41,992 |      1,660 |
| 231   |     52,232 |    52,089 |      21,431 |     21,428 |          3 |

The four converted graphs save **884-2,359 gzip bytes** and **3,034-7,030 raw
bytes**, including their generated loader code. These are per-scene results, not
additive application-wide savings. The simple graph exceeds the 1 KiB gzip keep
target. The remaining changes are small; their value also includes removing
duplicate code and correcting storage-texture access descriptors.

An independent library/bundle rebuild matches fetched bodies, manifests, module
attribution and exact accounting. The generated loader modules are present in
counted runtime chunks, while the general registry is absent from the four
converted scenes. All ceilings, payload exclusions and goldens are unchanged.
The combined scoped run covers 292 unit cases, package/test types, source/test
lint, generator freshness and three published-API/root-export assertions.
No performance or visual tests were run for this bundle campaign.

Evidence: session `3eaf8721-c709-45e3-acc3-1c52e502f504`,
`files/bundle-pr/report.json`, with `baseline/`, `candidate/`, `reproduced/`,
the retained patch and paired logs. The following sections preserve the earlier
incremental experiments and their original baselines; do not add those deltas
to the final combined table above.

## Retained: small gain only

Clearcoat-presence and sheen texture/albedo-scaling constants now live in their
owning lazy fragments, with unchanged bit numbers reserved in the shared ledger.
Measured alone, this saves 45-52 raw and 9-35 gzip bytes on the four PBR controls;
both Standard controls are byte-identical to the original baseline.

The shader composer now handles each binding kind once to produce both its
WebGPU descriptor and WGSL declaration, removing duplicate dispatch without
adding intermediate objects. Binding order, groups, stage visibility, and shader
text are preserved. The same path also fixes a latent storage-texture error:
WGSL `read`/`write`/`read_write` must become WebGPU `read-only`/`write-only`/`read-write`.
Against the freshly captured flag-only baseline, this change saves another
135-146 raw and 7-40 gzip bytes on every measured scene.

| Scene                     | Raw before | Raw after | Gzip before | Gzip after |
| ------------------------- | ---------: | --------: | ----------: | ---------: |
| 1: BoomBox                |     88,891 |    88,702 |      38,369 |     38,311 |
| 2: Standard               |     45,484 |    45,338 |      18,988 |     18,971 |
| 7: ChibiRex               |    105,880 |   105,692 |      46,215 |     46,179 |
| 28: Clearcoat             |     87,085 |    86,901 |      36,890 |     36,828 |
| 29: Sheen                 |     90,955 |    90,775 |      39,059 |     38,999 |
| 231: Standard deformation |     52,225 |    52,087 |      21,426 |     21,419 |

All values are bytes. Combined savings are **138-189 raw and 7-62 gzip bytes per
scene**, not a significant download reduction. Loaded chunk counts are unchanged.
An independent rebuild reproduces fetched files, manifests, bundle-info, and exact
accounting. The 149 focused cases include 78 binding-kind/group/stage combinations:
18 storage-descriptor cases fail before the fix and pass afterward; the other 131
pass on both sides. Scoped lint, package/test types, and filtered bundles pass.
No performance or visual tests, ceiling edits, or golden changes were made.

## Rejected and restored

WGSL alias normalization was initially retained but subsequently broke an existing
geometry-output variant case: `composePbrGeometryShader` depends on the original
PBR return-statement spelling. All three template changes and their architecture
notes are reverted; that case passes again. The old alias captures are historical
evidence, **not an accepted final result**.

Light-clone isolation saved bytes in non-cloning scenes but grew cloning controls.
Three variants were rejected: maximum gzip regressions were 48, 10, and 19 bytes.
All prototype source changes are restored; no compression-specific tuning remains.

Evidence: session `3eaf8721-c709-45e3-acc3-1c52e502f504`, `files/bundle-bindings/`:
flag-only `baseline/`, `candidate/`, `reproduced/`, paired logs, patches, and
hash-sealed `report.json`. Original baseline: `files/bundle-next/baseline/`.
Rejected cloning evidence: `files/bundle-structural/report.json`.

## Retained: Node pipeline descriptor consolidation

The generic NME compiler contributes 5,822 attributed bytes to scene62.
Two caster-output extraction variants were rejected and restored: the first
grew caster controls by 407-417 gzip bytes; the second still grew them by
75-91 bytes despite saving 531-763 gzip bytes in non-caster controls.

The retained change keeps output ownership and lazy boundaries unchanged:
construct the color/depth/ESM pipeline descriptor once instead of creating a
default descriptor and replacing both shader stages, alongside a second depth
descriptor. Geometry retains its existing callback. Shader text, binding order,
alpha/depth/culling behavior and synchronous rebuilds are preserved.

| Scene                | Raw before | Raw after | Gzip before | Gzip after |
| -------------------- | ---------: | --------: | ----------: | ---------: |
| 62: NME texture      |     57,786 |    57,125 |      25,270 |     25,126 |
| 66: NME full         |     88,867 |    88,207 |      43,601 |     43,405 |
| 140: NME PCF discard |     91,866 |    91,203 |      45,070 |     44,881 |
| 141: NME ESM discard |    114,271 |   113,612 |      50,856 |     50,708 |
| 149: NME geometry    |    101,736 |   101,080 |      43,485 |     43,273 |

This saves **656-663 raw and 144-212 gzip bytes per measured NME scene** versus
`5cdc7dc2`, without a regression in the five controls. This descriptor-only gain
is modest; the larger combined savings above also use graph-specific loaders.

The 35 focused cases pass before and after. Pre-change output snapshots cover
opaque/alpha-discard/fragment-depth graphs, cold views, nested output flags,
binding order, pipeline descriptors, and cache reuse; morph/environment binding
and resource-ownership cases also pass. An independent library/bundle rebuild
matches the retained candidate's fetched bodies, manifests, module attribution,
and exact accounting. Evidence is under `files/bundle-node-pass/` in the same
session, including `report-candidate-candidate-v2-candidate-v3-reproduced.json`.

## Retained: graph-specific registries

An opt-in loader accepts a fixed list of root-exported `NodeMaterialBlock`
descriptors. Each descriptor carries its class name and an internal lazy loader;
no GPU handles are added to the public selection API. Selecting blocks removes
the general registry but preserves lazy imports, including for unbundled package
consumers. The dynamic/default loader is unchanged.
Missing and duplicate selections reject explicitly.

The block catalog is generated from the existing registries. A graph-loader
generator resolves the same core/full PBR choice as the default loader,
including disconnected serialized blocks, side-effect blocks and geometry
terminals. Generated loaders are ordinary counted runtime modules, never
excluded `*-nme.ts` data payloads. The simple texture graph exceeds the 1 KiB gzip
keep target. Full NME, loop and geometry graphs also shrink. The user explicitly
accepted control drift of up to +4 gzip bytes in scene2 and +3 raw bytes in
scene141 during the isolated experiment; no ceilings were changed. The final
combined result against current master has no regression in either control.

The first eager catalog exceeded scene ceilings and was rejected. A per-block
static variant saved more bytes for bundler consumers but connected every block
implementation to unbundled root imports. It was superseded by the lazy design,
not shipped. No eager selector modules remain.

Graph precompilation was assessed separately and deferred: Maps, feature callbacks,
live inputs and geometry re-emission need a dedicated representation and API.
It is not necessary for the registry gain and is not part of this PR.
