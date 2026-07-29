# Module: Alpha-to-Coverage

> Package path: `packages/babylon-lite/src/render/alpha-to-coverage.ts`
> Pipeline seams: the PBR/Standard/Shader material pipelines, scene-attached text pipeline, depth-hosted Sprite2D pipeline, and billboard pipeline.

## Purpose

Provide opt-in WebGPU alpha-to-coverage for multisampled Standard, PBR, and Shader material pipelines and for the depth-writing text/sprite pipeline owners that benefit most from it. Alpha-to-coverage converts fragment alpha into a per-sample coverage mask before depth/stencil and color writes. It is useful for depth-writing antialiased text, cutout sprites, foliage, and ordered opaque surfaces. Applications that do not request it retain only the small resolver seams in pipeline-owner modules; the feature state and behavior are tree-shaken.

The feature owns only multisample coverage state. It does **not** silently enable alpha blending, change fragment alpha, or change a material's depth-write policy. A caller that wants the common opaque-replacement A2C mode emits fractional alpha while keeping blending disabled and depth writes enabled.

## Public API Surface

```typescript
export type AlphaToCoverageTarget = StandardMaterialProps | PbrMaterialProps | ShaderMaterial | TextRenderable | Sprite2DLayer | BillboardSpriteSystem;

/** Enable or disable alpha-to-coverage for one pipeline-owning target.
 * Call before registerScene()/adding the target to a scene. Material changes after
 * registration require rebuildMaterial(). */
export function setAlphaToCoverage(target: AlphaToCoverageTarget, enabled: boolean): void;

/** Return the requested alpha-to-coverage state for a target. Defaults to false. */
export function getAlphaToCoverage(target: AlphaToCoverageTarget): boolean;
```

Both functions and `AlphaToCoverageTarget` are explicitly re-exported from the package root. Public objects remain pure state; no method or raw `GPURenderPipeline`/`GPUDevice` handle is exposed.
`NodeMaterial` is deliberately rejected by the generic public signatures and by a runtime family check because its pipeline is compiled before this per-owner option can be applied.

Effective target paths are deliberately narrower than every text/sprite API:

- `StandardMaterialProps`, `PbrMaterialProps`, and `ShaderMaterial`: main-pass material pipelines.
- `TextRenderable`: effective only when it participates in depth and the scene target is multisampled. The A2C variant uses replacement color plus per-sample depth writes.
- `Sprite2DLayer`: effective only for a scene-hosted `depth: "test-write"` layer on a multisampled target.
- `BillboardSpriteSystem`: effective only for a depth-writing cutout system on a multisampled target.
- Standalone `TextRenderer` and `SpriteRenderer` HUD passes render directly to a 1x swapchain and continue to use alpha blending; they are not `AlphaToCoverageTarget`s.

## Internal Architecture

### Optional state

`alpha-to-coverage.ts` owns a lazily allocated `WeakSet<AlphaToCoverageTarget>`:

- module load allocates nothing;
- `setAlphaToCoverage(target, true)` creates the set on first use and adds the target;
- `setAlphaToCoverage(target, false)` deletes the target without allocating;
- `getAlphaToCoverage()` and the internal resolver return `false` while the set is absent.

The module installs its internal resolver into `alpha-to-coverage-hook.ts` when the first target is enabled. Shader, Standard, PBR, text, and sprite pipeline owners read that null-by-default hook instead of importing the complete feature module merely to ask whether a target is enabled. When the setter is absent, minification folds the resolver branches away. The remaining seams move typical existing scene bundles by only a few raw bytes and must stay within their existing ceilings.

### Material pipeline integration

For each main-pass material family:

1. Resolve the material's A2C request while building the renderable.
2. Keep shader composition, bind-group layouts, and bind groups shared between enabled and disabled materials. When the A2C resolver is installed, the shared bindings also reuse GPU shader modules across normal/A2C variants; without A2C, module creation follows the existing per-pipeline path.
3. Add an A2C discriminator only to the render-pipeline key.
4. Emit `multisample.alphaToCoverageEnabled = true` only when the material is enabled **and** the target signature has `_sampleCount > 1`.
5. Leave single-sample descriptors disabled (WebGPU fallback behavior).

Standard, PBR, and Shader bindings are shared across A2C states because A2C does not change shader source or resource layout. Their pipeline keys alone include the resolved A2C state.

No frame hot path reads mutable A2C state: it is baked into immutable pipelines during binding/registration.

### Text pipeline integration

The ordinary Slug text fragment and its premultiplied-alpha blend are left unchanged. A separate A2C Slug fragment keeps full glyph RGB and puts analytic coverage only in alpha. That source is retained only when the null resolver hook can select an A2C text owner. The A2C `TextRenderable` variant:

1. requires depth writes and `sampleCount > 1`;
2. adds an A2C discriminator to the text pipeline key;
3. omits color blending (replacement color);
4. sets `alphaToCoverageEnabled: true`.

Covered samples therefore receive the glyph's full RGB and depth while analytic edge alpha selects sample coverage. This avoids applying coverage twice. The standalone `TextRenderer` keeps the ordinary blended 1x pipeline.

### Sprite pipeline integration

For a depth-hosted `Sprite2DLayer`, A2C is effective only when `depth === "test-write"` and the target is multisampled. The existing layer object is the pipeline owner and cache discriminator. A2C preserves the selected blend descriptor; callers wanting replacement color/depth use `spriteBlendOpaque` explicitly. Pure-2D/HUD layers remain 1x paths.

For a `BillboardSpriteSystem`, A2C is effective only for the depth-writing `cutout` mode and a multisampled target. Its A2C shader variant removes the binary `alphaCutoff` discard so texture alpha drives the sample mask continuously; its pipeline uses replacement color and per-sample depth writes. Transparent/additive billboard modes retain their existing blend paths.

## Pipeline Configuration

```typescript
multisample: {
    count: target._sampleCount,
    alphaToCoverageEnabled: requested && target._sampleCount > 1,
}
```

All other pipeline fields are unchanged. In particular:

- blend state remains material-controlled;
- depth compare/write remain material-controlled;
- the fragment shader's alpha output is the coverage source;
- 1x targets behave exactly as if A2C were disabled.

## State Machine / Lifecycle

```text
target created
    -> setAlphaToCoverage(target, true|false)
    -> registerScene(scene)
    -> A2C state is baked into cached pipelines

runtime state change
    -> setAlphaToCoverage(material, ...)
    -> rebuildMaterial(scene, material)
    -> bindings select/build the matching pipeline variant
```

Disposal needs no explicit cleanup because the `WeakSet` does not retain targets.

## Babylon.js Equivalence Map

| Babylon.js                                      | Babylon Lite                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `engine.setAlphaToCoverage(true)` before a draw | `setAlphaToCoverage(pipelineOwner, true)` before registration      |
| `engine.getAlphaToCoverage()`                   | `getAlphaToCoverage(pipelineOwner)`                                |
| WebGPU pipeline cache A2C bit                   | Pipeline variant key or text/sprite owner key                      |
| MSDF `writeToDepthBuffer`                       | depth-writing A2C `TextRenderable`                                 |
| A2C + `ALPHA_REPLACE_COLOR`                     | A2C pipeline variant with no blend descriptor                      |
| `alphaToCoverageEnabled && sampleCount > 1`     | same WebGPU descriptor rule, additionally gated by depth ownership |
| global imperative pipeline state                | immutable per-owner pipeline state                                 |

The per-owner API is intentional: WebGPU alpha-to-coverage is pipeline state, while Lite records pipelines/bundles ahead of drawing and has no mutable engine draw-state object.

## Dependencies

- Type-only references to the three supported material families, `TextRenderable`, `Sprite2DLayer`, and `BillboardSpriteSystem`.
- PBR, Standard, and Shader main-pass pipeline builders.
- Scene-attached text, depth-hosted Sprite2D, and billboard pipeline builders.
- WebGPU `GPUMultisampleState.alphaToCoverageEnabled`.
- No external runtime dependency and no GPU handle in the public API.

## Test Specification

1. Focused unit tests verify enabled 4x Shader pipelines set `alphaToCoverageEnabled: true`.
2. The same test verifies 1x pipelines remain disabled.
3. Equivalent Shader materials with opposite A2C state must not share a pipeline.
4. Focused tests build real Standard/PBR renderables through the public setter, verify shader bindings/modules remain shared, and verify only the multisampled pipeline variant changes.
5. Scene 53 verifies the depth-hosted Sprite2D integration uses explicit `spriteBlendOpaque` with A2C; its hard-alpha atlas is not fractional-coverage proof.
6. Scene 57 verifies the cutout billboard A2C pipeline on WebGPU; its binary atlas is not fractional-coverage proof.
7. Scene 274 renders red/green overlap with A2C off and on, and is compared against the Babylon.js WebGPU golden with the standard full-image MAD gate. The two demo rows are separated so no card overlaps a card from the other row: cross-row overlap would produce identical depth values, and a depth tie resolves differently under reverse-Z `greater-equal` than under strict `LESS`, which would desynchronize the WebGPU and WebGL2 scenes for reasons unrelated to alpha-to-coverage.
8. Scene 275 provides the fractional-coverage proof: overlapping depth-writing MSDF text runs through the dedicated Slug A2C fragment shader and asserts that partial glyph-edge samples mix front/rear colors.
9. Rebuilding existing Shader, Standard, PBR, text, and sprite scenes that do not import A2C must keep their small raw-byte movement within existing ceilings.

## File Manifest

- `render/alpha-to-coverage.ts` — public target state functions plus internal lazy resolver installation.
- `render/alpha-to-coverage-hook.ts` — null-by-default seam used by all optional A2C pipeline owners.
- `material/pbr/pbr-pipeline.ts` — shares PBR shader resources and emits the A2C pipeline variant.
- `material/pbr/pbr-renderable.ts` — resolves per-material A2C state for pipeline selection.
- `material/standard/standard-pipeline.ts` — shares Standard shader resources and emits the A2C pipeline variant.
- `material/standard/standard-renderable.ts` — resolves per-material A2C state for pipeline selection.
- `material/shader/shader-pipeline.ts` — Shader cache-key and descriptor seam.
- `text/_gpu/text-pipeline.ts` — premultiplied-alpha normal variant and replacement-color A2C variant.
- `text/shaders/slug-a2c.frag.wgsl` — A2C output variant (full RGB, coverage in alpha only).
- `text/text-renderable.ts` — supplies the scene text pipeline owner.
- `sprite/sprite-pipeline.ts` — depth-hosted Sprite2D cache-key, blend, and descriptor seam.
- `sprite/billboard-pipeline.ts` — cutout billboard shader/cache/descriptor seam.
- `index.ts` — explicit root exports.
- `tests/lite/unit/alpha-to-coverage.test.ts` — focused pipeline tests.
- `lab/lite/src/{bjs,lite}/scene274.ts` and parity assets — material A2C visual parity scene.
- `lab/lite/src/{bjs,lite}/scene275.ts` and parity assets — depth-writing MSDF text A2C visual parity scene.
