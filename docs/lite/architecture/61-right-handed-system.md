# Module: Right-Handed Coordinate System

> Package paths:
>
> - `packages/babylon-lite/src/engine/coordinate-system.ts` (default variant, left-handed)
> - `packages/babylon-lite/src/engine/coordinate-system-rh.ts` (`babylon-lite-rh` variant)

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

Both variants export `_rightHanded` as a `const` (`null` or `true`). The scene bundler does **not**
fold an imported constant across modules: the bundle still contains `_rightHanded ? … : …`, and only
the per-chunk minifier, which sees the value, drops the dead branch. So the dead branch disappears,
but anything it _imports_ has already been linked into the bundle by then. A left-handed bundle is
byte-identical to one built before this feature only because right-handed branches import nothing of
their own (see [Writing handedness-dependent code](#writing-handedness-dependent-code)).

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
- **Camera world matrix** — arc-rotate, free and geospatial cameras build their left-handed look-at
  matrix, then negate its X and Z basis columns in place: `W_RH = W_LH·diag(-1, 1, -1)`, so the camera
  looks down its local -Z with +X to the right, like Babylon.js. Camera inputs, gizmos and XR read the
  camera's forward as local -Z accordingly.
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

- **Everything else** — each Babylon.js `useRightHandedSystem` branch reachable from a Lite feature has
  its counterpart: light views of shadow maps and cascades, the linear-depth pass, Standard skybox and
  reflections (`REFLECTIONMAP_OPPOSITEZ`, spherical mapping), the PBR cubemap skybox and background
  ground, shader-material system uniforms (`view`, `viewProjection`, … are handed to user shaders as
  Babylon.js's right-handed matrices), the derivative normal view, node-material `View`/`Projection`
  inputs and PBR helpers, billboard and billboard-picking texture U, camera inputs, gizmos, the
  geospatial camera, `.babylon` cameras, glTF cameras, interactivity
  camera paths, the procedural sky, CSG2, Havok mesh shapes, USD roots and normal maps, and WebXR
  (poses, pointer, teleport, hand meshes, controller models), which stays in WebXR's native
  right-handed space instead of being Z-mirrored. `EXT_lights_image_based` keeps one convention:
  the right-handed environment sampling already mirrors its yaw, and twin 342 renders exactly like
  scene 265.

Files whose handedness-sensitive code needs no seam are listed, with the reason, in `HANDEDNESS_EXEMPT`
of `tests/lite/unit/handedness-guard.test.ts` (orthographic projection, text, glTF primitive winding,
node and Standard bump frames).

## Writing handedness-dependent code

- Import the flag from `#coordinate-system`, never by relative path.
- Prefer `_rightHanded ? a : b`, `...(_rightHanded && { … })` and `if (_rightHanded !== null) { … }`.
- **A right-handed branch must not import anything the file's left-handed code does not already use.**
  The minifier removes the dead branch only after the bundler has linked its imports: an imported
  helper survives in the left-handed bundle (as an export of a shared chunk when caller and helper
  land in different chunks). Write the right-handed code inline, or as a function of the same module.
  `right-handed-drift.test.ts` fails on such an import.
- Inside a `wgsl`-tagged template, the tag minifies the static text only: write interpolated WGSL
  variants already minified, or the left-handed shader text changes.
- Check a change with the filtered scene bundles: every left-handed scene must keep master's
  `rawBytes` in `lab/public/bundle/master-manifest.json`.
- Add a pair test to `right-handed-pairs.test.ts` for the new branch (or a twin scene); the
  coverage guard below fails otherwise.

## Tests

Four guards keep the right-handed variant from rotting while every other test, scene and golden
exercises the left-handed one:

- **Drift** — `tests/lite/unit/right-handed-drift.test.ts` reduces every `_rightHanded` decision to the
  token difference between its right-handed and left-handed code and compares it with a committed
  snapshot. Editing both branches the same way keeps it green; editing only the left-handed one fails
  and names the site. An intended change to the right-handed port is reviewed and accepted with
  `vitest -u`. The same file holds the leak guard: no right-handed branch imports a symbol that the
  left-handed code of its file does not use.
- **Behavior pairs** — `tests/lite/unit/right-handed-pairs.test.ts` runs the same input through a
  left-handed and a right-handed build of the engine (`right-handed-builds.ts` swaps the
  `#coordinate-system` module) and asserts the documented relation between the two results: mirrored
  camera paths after the same drags, the same gizmo rotation, shader text that differs by exactly the
  ported expression, skeleton worlds mirrored in X. A left-handed change not carried to the
  right-handed path breaks the relation.
- **Coverage** — `tests/lite/unit/handedness-guard.test.ts` fails when an engine file holds
  handedness-sensitive code (`frontFace`, a left-handed matrix builder, the glTF root mirror, a
  derivative-based tangent frame) without importing `#coordinate-system` or being exempt, and when a
  file importing it is neither imported by a `right-handed-*.test.ts`, nor rendered by a twin scene
  listed in `RH_TWIN_COVERAGE`, nor declared as a known gap in `RH_DRIFT_ONLY`.
- **Right-handed twin scenes** (`"rightHanded": true` in `scene-config.json`, 321–347) — parity
  against Babylon.js with `useRightHandedSystem = true`. Their Lite wrapper and Babylon.js reference
  only import the source scene (the reference through `lab/lite/src/bjs/right-handed-twin.ts`), so they
  follow every change to it, and CI's impact selection runs them with the source. The guard checks
  that they stay pure re-runs. Two Babylon.js 9.28 right-handed bugs are worked around on the
  reference side: `right-handed-twin.ts` replaces the zero refraction matrix of an unrotated
  `CubeTexture` (twin 334), and twin 342 keeps scene 265's left-handed reference (`BJS_RH_BROKEN`)
  because Babylon.js lights `EXT_lights_image_based` wrongly when right-handed.

Also:

- `tests/lite/unit/right-handed-system.test.ts` and `right-handed-seams.test.ts` — view matrices
  against Babylon.js `LookAtRH`, camera world matrices, front-face flips and per-seam values.
- `tests/lite/unit/coordinate-system-variants.test.ts` — both variants and the `imports` map.
- The `build` test project bundles the published `build/lib`, where `#coordinate-system` stays a
  bare specifier. Bare Rollup does not read `imports`, so its harness resolves the specifier with
  `packageImportsPlugin()` (`tests/lite/build/bundler-harness.ts`), as `@rollup/plugin-node-resolve`
  does for a consumer; webpack reads the map natively.
