# Module: Right-Handed Coordinate System

> Package paths:
>
> - `packages/babylon-lite/src/engine/coordinate-system.ts` (default variant, left-handed)
> - `packages/babylon-lite/src/engine/coordinate-system-rh.ts` (`babylon-lite-rh` variant)
> - `packages/babylon-lite/src/engine/right-handed-helpers.ts`

## Purpose

Let an application render in Babylon.js's right-handed system (`scene.useRightHandedSystem = true`)
instead of Lite's default left-handed one, without making left-handed applications pay a byte or a
runtime test.

User guide, with the setup for each bundler:
[Right-Handed Coordinate System](../07-right-handed-system.md).

## Choosing the handedness

Engine modules read one flag, `_rightHanded` (`true` or `null`), from the package import
`#coordinate-system`. The package `imports` map resolves it by **bundler resolve condition**:

| Condition         | Variant                   | Handedness   |
| ----------------- | ------------------------- | ------------ |
| _(none)_          | `coordinate-system.ts`    | left-handed  |
| `babylon-lite-rh` | `coordinate-system-rh.ts` | right-handed |

```ts
// vite.config.ts — the application is right-handed; it keeps calling createEngine.
export default defineConfig({ resolve: { conditions: [...defaultClientConditions, "babylon-lite-rh"] } });
```

Other bundlers use their own condition option: webpack `resolve.conditionNames`, esbuild
`--conditions`, Rollup `@rollup/plugin-node-resolve` `exportConditions`. Vite's `resolve.conditions`
replaces the defaults, hence `defaultClientConditions`.

Handedness is fixed for the whole bundle: every engine it creates has the same handedness.

The prebundled CDN file (`dist/index.js`) is built with the default variant and is left-handed only.

### Why a build-time choice

Both variants export `_rightHanded` as a `const`. Rolldown inlines exported constants across
chunks, so every `_rightHanded ? … : …` folds to one branch and the other branch, its helpers and
its imports are dropped; a left-handed bundle is byte-identical to one built before this feature.

A runtime flag cannot get that: in a code-split bundle the flag lives in one chunk and is imported by
the lazy ones (PBR pipeline, background ground…), and no bundler can prove an imported `let` is never
reassigned. Measured on 18 lab scenes, a runtime flag cost 0–0.4 KB raw (≤ 0.1 KB gzip) per scene,
so the choice is left to the application's bundler.

## Model

A right-handed engine renders the world exactly as a left-handed engine renders the Z-mirrored world.
With `Sz = diag(1, 1, -1)`:

- **View** — `getViewMatrix` returns `Sz·V_RH` (third row negated). The projection stays the
  left-handed one; since Babylon.js's right-handed projections are the left-handed ones times `Sz`,
  clip space equals Babylon.js's `P_RH·V_RH`. Every shader keeps seeing the usual left-handed view
  space (+X right, +Y up, +Z forward).
- **Camera world matrix** — arc-rotate and free cameras build their left-handed look-at matrix, then
  `_toRightHandedCameraWorld` negates the X and Z basis columns: `W_RH = W_LH·diag(-1, 1, -1)`, so the
  camera looks down its local -Z with +X to the right, like Babylon.js.
- **Winding** — the mirrored view reverses triangle winding on screen, so camera-pass pipelines flip
  `frontFace`: `"cw"` for ordinary meshes (Babylon.js's right-handed rule), and the mirrored-mesh rule
  in `std-mirrored-support.ts` is inverted.
- **glTF** — the loader keeps glTF's native right-handed space: the `__root__` node has no X mirror,
  `computeNodeWorldMatrix` drops the root conversion, the skeleton and animation-mixer root transforms
  (`skeleton-pose.ts`, `skeleton-updater.ts`, `weighted-gltf-mixer.ts`) are the identity to match, the
  glTF camera fixup keeps +X, and the primitive feature module (per-mesh winding) is always loaded.
  `Mesh._authoredSign` stays `-1`: it is relative to the left-handed rule, which the right-handed
  winding in `std-mirrored-support.ts` already inverts.
- **Environment** — `rotateY` in the PBR IBL helpers (and the mesh-LoD copy) negates Z after the
  rotation, like Babylon.js's `REFLECTIONMAP_OPPOSITEZ`, for radiance, irradiance, clearcoat and local
  cubemaps.
- **Normal mapping without tangents** — the PBR cotangent frames (base normal map, clearcoat normal
  map, anisotropy direction, mesh-LoD copy) reverse both their tangent and bitangent, like Babylon.js's
  glTF loader, which ties `invertNormalMapX/Y` to the handedness. Standard and node materials keep
  their frames: Babylon.js flips those only on explicit options.

## Not covered yet

Shadow and depth-only passes (light view matrices are not mirrored), the skybox shader, standard
material reflections, node PBR, refraction, parallax, free-camera input directions, the geospatial
camera, the USD loader, spot lights, sprites, SSR, probes, gizmos, XR, text, and any code reading the camera world
matrix's third column as "forward".

## Writing handedness-dependent code

- Import the flag from `#coordinate-system`, never by relative path.
- Prefer `_rightHanded ? a : b` and `...(_rightHanded && { … })`; both fold to the original
  left-handed code.
- Call an imported right-handed helper only inside `if (_rightHanded !== null) { … }`. Tree-shaking
  drops the import there, but keeps one referenced from `_rightHanded && f(x)` or `_rightHanded ? f(x) : y`:
  only the minifier removes that dead expression, after the helper has already been kept.
- Inside a `wgsl`-tagged template, the tag minifies the static text only: write interpolated WGSL
  variants already minified, or the left-handed shader text changes.
- Check a change with the filtered scene bundles: every left-handed scene must keep master's
  `rawBytes` and content-hashed chunk names in `lab/public/bundle/manifest.json`.
- `tests/lite/unit/handedness-guard.test.ts` enforces the first rule: a file with handedness-sensitive
  code either imports the seam or is listed in its `HANDEDNESS_EXEMPT` map with the reason.

## Tests

- `tests/lite/unit/right-handed-system.test.ts` — view matrices against Babylon.js `LookAtRH`, camera
  world matrix, front-face flip, environment and cotangent shader text.
- `tests/lite/unit/coordinate-system-variants.test.ts` — both variants and the `imports` map.
- The `build` test project bundles the published `build/lib`, where `#coordinate-system` stays a
  bare specifier. Bare Rollup does not read `imports`, so its harness resolves the specifier with
  `packageImportsPlugin()` (`tests/lite/build/bundler-harness.ts`), as `@rollup/plugin-node-resolve`
  does for a consumer; webpack reads the map natively.
- `tests/lite/unit/handedness-guard.test.ts` — fails when an engine file holds handedness-sensitive
  code (`frontFace`, a left-handed matrix builder, the glTF root mirror, a derivative-based tangent
  frame) without importing
  `#coordinate-system` or being listed in `HANDEDNESS_EXEMPT` with a reason, and when a right-handed
  twin scene stops being a pure re-run of its left-handed source.
- Right-handed twin scenes (`"rightHanded": true` in `scene-config.json`): parity against Babylon.js
  with `useRightHandedSystem = true`. Their Lite wrapper and Babylon.js reference only import the
  source scene (the reference through `lab/lite/src/bjs/right-handed-twin.ts`), so they follow every
  change to it, and CI's impact selection runs them with the source.
