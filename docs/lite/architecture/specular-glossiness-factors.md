# Specular-glossiness factors

> Package paths: `packages/babylon-lite/src/loader-gltf/` and `packages/babylon-lite/src/material/pbr/`

## Purpose and root cause

Implement the [Khronos KHR_materials_pbrSpecularGlossiness equations](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Archived/KHR_materials_pbrSpecularGlossiness/README.md) for textured and factor-only materials. Factors are linear multipliers; missing textures and factors contribute one.

Previously, the loader did not propagate SG `diffuseFactor`. It reduced `specularFactor` to a scalar maximum in `reflectance` and stored `1 - glossinessFactor` in the MR roughness field. The texture-only SG shader read RGB and alpha directly, ignoring those fields. Without an SG texture, shader selection fell through to MR, losing colored specular reflectance. Core MR diffuse fallback data could also leak into supported SG materials. The correction retains the original factors and selects SG independently of texture presence, without conversion to MR or asset-specific conditions.

## Material representation and loader boundary

The existing public `PbrMaterialProps.specGlossTexture?: Texture2D` remains compatible. No new public API is required. Internal state is:

```typescript
// On PbrMaterialProps; @internal, removed from published declarations.
_specularGlossiness?: [number, number, number, number];
```

The tuple is `[specularFactor.r, specularFactor.g, specularFactor.b, glossinessFactor]`. Its presence selects the SG factor workflow. `baseColorFactor` carries SG diffuse RGBA through its existing floating-point path. Defaults are diffuse `[1, 1, 1, 1]`, specular `[1, 1, 1]`, and glossiness `1`.

The glTF SG extension registers the lazy `base-spec-gloss` PBR extension before returning the tuple. It clears the parsed core `_baseColorFactor` to white and `_baseColorImage` to null before default texture assembly, then supplies SG textures and factors as extension overrides. Absent SG diffuse textures therefore use white even when an MR fallback exists. Material `alpha` is one; diffuse-factor alpha is applied exactly once through `baseColorFactor`.

Both ordinary and variant loaders run material extensions before assembling default textures. SG uses the existing `preParse` hook to remove only `pbrMetallicRoughness.baseColorTexture` on SG materials in the loader-owned working JSON. All `preParse` hooks finish before texture-source `preMesh` hooks and core material assembly. Thus generic loaders never construct the superseded diffuse fallback, and missing SG diffuse reuses the builder's single white texture. Normal, occlusion and emissive references and MR-only materials remain intact. Variants receive the same prepared JSON. Registry merge order also places BasisU before SG; BasisU has no SG knowledge. This correction does not implement compressed SG texture decoding.

Texture uploads request sRGB formats. Hardware sampling decodes RGB and leaves alpha linear. Transform wrappers remain on extension-selected textures; `texCoord: 1` is preserved even without `KHR_texture_transform`. The extended builder derives the diffuse UV mask from the final selected texture. UV transforms are enabled only when present.

## Shader and material UBO

The lazy fragment implements the existing `PbrExt` lifecycle: `detect` selects material bit 9, `frag` contributes one `vec4<f32> specularGlossiness` UBO field, and `writeUbo` writes four scalars at the composed byte offset. Bit 9 was formerly an unused cotangent-normal constant; normal mode continues to derive from normal-map presence and mesh tangents. The shared flag file reserves the bit without exporting a runtime constant.

The fragment contributes assignments at the existing `MF` slot. The core composer has no SG factor hook or registry lookup. Existing BRDF locals (`roughness`, `metallic`, `colorF90`, `surfaceAlbedo`) are mutable with identical initial values. The SG fragment reuses the legacy `specGloss` sample for textured materials and reads the tuple directly otherwise.

Initializer IDs establish the existing composer's deterministic order: `base-f0` (reflectance), then `base-spec-gloss` (SG), then clearcoat, iridescence and material plugins. SG depends on `base-f0` when reflectance is active. Existing clearcoat/iridescence reflectance dependencies target `base-f0`; neither modifier knows SG. The composer lexically sorts ready fragments and reinserts newly ready fragments in that order. Consequently SG runs before modifiers even when it first waits for reflectance, including factor-only or animated-occlusion reflectance. Registration order does not affect this result.

Reflectance uses the same registry and fragment ID, `base-f0`, with and without UV transforms. Both composer and pipeline cache keys already include `features2`, which distinguishes its UV transform bit and layout. Material bindings follow the composed fragment order and match the registry ID, so the canonical identity preserves texture bindings and distinct UV variants. The initializer prefix describes the fragment's role and costs no new core capability or feature check.

The plugin bridge returns its original cached contribution, preserving every dependency and avoiding per-material cloning. At base `d44c413eb217acf93801e9a3f5247149c845dac9`, MR reflectance plus `CUSTOM_FRAGMENT_BEFORE_LIGHTS` composed as `plugin-1|reflectance` (or `plugin-1|reflectance-U`), overwriting the plugin's F0 modification. This pre-existing ordering bug is corrected generically by `base-f0|plugin-1`; SG composes as `base-f0|base-spec-gloss|clearcoat|iridescence|plugin-1` when all are active. Clearcoat, iridescence and the plugin bridge have no SG bit or ID knowledge. Reflectance retains its unchanged occlusion calculation; SG assigns RGB F0, white F90, zero metallic, corrected roughness and surface albedo before modifiers.

The common base-color path computes diffuse and vertex color. With texture samples `d` and `s` already decoded, and absent samples replaced by one:

```text
diffuse.rgb = d.rgb * diffuseFactor.rgb * vertexColor.rgb
diffuse.a = d.a * diffuseFactor.a * vertexColor.a
specular = s.rgb * specularFactor.rgb
glossiness = s.a * glossinessFactor
roughness = clamp(1 - glossiness, 0, 1)
metallic = 0
F0 = specular
surfaceAlbedo = diffuse.rgb * (1 - max(specular.r, specular.g, specular.b))
```

Absent vertex color is one. `max` is used only for diffuse energy conservation, never to replace RGB F0. The ordinary BRDF subsequently squares perceptual roughness and applies its existing numerical floor and optional antialiasing. Factor multiplication does not occur in encoded sRGB space, and alpha is neither decoded nor premultiplied into RGB.

The minimal material UBO grows from 32 to 64 bytes for loader-created SG: 16 bytes for the existing diffuse RGBA slot and 16 bytes for the SG tuple. Other extension fields remain additive and use the normal layout composer. MR materials and directly created legacy texture-only SG materials acquire no SG tuple field.

## Compatibility, lifecycle, and cost

The template retains its legacy texture-only SG equations. Directly created `specGlossTexture` materials therefore work without registering or preloading the glTF factor extension, including runtime material rebuilding. `pbr-renderable.ts` is unchanged. MR keeps its existing data path and equations. Alpha MASK/BLEND, double-sided state, normal mapping, lighting, and IBL continue through the existing pipeline.

Registration, tuple creation, texture wrappers, shader strings, and pipeline construction occur during setup or material rebuilding. The UBO writer updates existing storage with scalar assignments. There are no added steady-frame heap allocations, texture samples, texture resources, samplers, or bind-group entries. The existing material-buffer binding has a larger range for factor SG. The new arithmetic for textured SG is one componentwise RGBA multiply for diffuse and one for specular/glossiness, at most eight scalar multiplications; diffuse uses the existing multiplier. Factor-only SG directly reads its tuple without a texture sample.

The factor-workflow bit distinguishes loader SG from MR and legacy SG in the existing pipeline cache key. Texture presence remains an independent existing distinction. Factor values are uniforms and create no per-value shader permutations. MR feature keys are unchanged.

Fresh scoped builds against `d44c413eb217acf93801e9a3f5247149c845dac9` measure uncompressed, fetched minified runtime JS with the repository bundle harness:

| Scene | Non-SG witness               | Base bytes | Corrected bytes | Delta |
| ----- | ---------------------------- | ---------: | --------------: | ----: |
| 1     | glTF / IBL                   |     89,503 |          89,503 |     0 |
| 6     | PBR / IBL                    |     73,263 |          73,263 |     0 |
| 27    | Reflectance / variants       |     84,376 |          84,344 |   -32 |
| 30    | Transmission / UV transforms |    106,237 |         106,234 |    -3 |
| 19    | Clearcoat                    |     70,652 |          70,648 |    -4 |
| 177   | Iridescence                  |     70,363 |          70,359 |    -4 |
| 217   | Material plugins             |     78,193 |          78,193 |     0 |

All seven witnesses meet the no-growth requirement; no ceiling changes. Clearcoat, iridescence and the plugin bridge are retained in their respective scene entry chunks, rather than separate dynamic chunks in these native API scenes. The clearcoat/iridescence dependency ID change saves four bytes in each entry; the plugin bridge has exactly its base implementation and size. Scene 27 saves 29 bytes in its reflectance setter/fragment chunk and three in the generic final-texture UV builder. Scene 30 saves the same three builder bytes. Hashes may change without a size change.

The unfetched SG chunk grows from 459 to 1,735 bytes in scenes 1/27 and to 1,738 bytes in scene 30; scenes 6/19/177/217 build no SG chunk. This is 21 bytes smaller than the previous factor candidate. All SG factor code remains inside the opt-in chunk. Bundle module inventories are captured before the harness removes no-op Vite preload wrappers; the figures above use final served JS payload lengths after that existing pass, not the earlier module inventory's chunk-size field. No compressed transfer metric is used for the gate.

## Validation

Synthetic tests use real glTF material assembly, extension hooks, the composer, the UBO writer, and hardware sRGB sampling. A test-only `PbrExt` contributes a typed storage-texture binding and `BC` slot code. It renders the full production vertex and fragment shaders and observes diffuse, F0/F90, glossiness/roughness, surface albedo and occlusion as four deterministic RGBA texels. `BC` executes late in the shader; the observed locals remain the BRDF input values, unaffected by output lighting and tone mapping. All layouts and UBO offsets come from typed composer metadata. The fixture maps its own storage binding from WGSL access `write` to WebGPU access `write-only`; it neither parses nor replaces emitted WGSL. The occlusion case observes a nonwhite ORM sample mixed with strength. The plugin cases halve initialized F0 at `CUSTOM_FRAGMENT_BEFORE_LIGHTS`, proving both SG and MR reflectance initialization precede plugins. Production code has no probe or emitted-WGSL parsing.

Independent numerical expectations cover defaults, every factor-only/texture-only/product case, combined nonuniform factors, diffuse alpha, MASK discard/survival, BLEND alpha, vertex color, UV transforms/TEXCOORD selection, variant and ordinary MR-fallback isolation, legacy texture-only SG, and an MR control. CPU tests check floating-point packing, default tuples, compressed MR diffuse isolation, legacy operation without SG registration, and identical MR flags/shaders/layout/UBO values across a verified absent-to-present SG registration transition. Focused ordering cases cover MR reflectance factors/textures/transforms plus plugins and SG with absent/factor/textured/transformed reflectance plus clearcoat, iridescence and plugins. A shared-composer test verifies distinct UV layout cache entries. Existing scoped PBR/glTF tests, parity scenes, and bundle ceilings remain regression gates. Fixtures contain only owned synthetic texels; no external scene assets are required.

## File manifest

- Loader: `gltf-ext-spec-gloss.ts`, `gltf-feature-registry.ts`, `gltf-pbr-builder-ext.ts`, `gltf-variants.ts`.
- Material: `pbr-material.ts`, `pbr-flag-bits.ts`, `pbr-template.ts`, `fragments/spec-gloss-fragment.ts`, `fragments/reflectance-fragment.ts`, `fragments/clearcoat-fragment.ts`, `fragments/iridescence-fragment.ts`, `../plugin/pbr-plugin-bridge.ts`.
- Tests: `tests/lite/unit/gltf-spec-gloss-factors.test.ts`, `tests/lite/plumbing/spec-gloss-fixture.ts`, `tests/lite/plumbing/spec-gloss-factors.spec.ts`.
