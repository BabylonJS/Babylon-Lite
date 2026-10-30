# Module: Right-Handed Coordinate System

> Package paths:
>
> - `packages/babylon-lite/src/engine/coordinate-system.ts` (default variant, left-handed)
> - `packages/babylon-lite/src/engine/coordinate-system-rh.ts` (`babylon-lite-rh` variant)

## Purpose

Let an application render in Babylon.js's right-handed system (`scene.useRightHandedSystem = true`)
instead of Lite's default left-handed one, without making left-handed applications pay a byte or a
runtime test (with a minifier that inlines imported constants, as Rolldown does; see
[Why a build-time choice](#why-a-build-time-choice)).

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

That holds for the lab's bundler, Rolldown, whose minifier inlines the imported constant; it is
checked scene by scene. esbuild's minifier (0.28) does not inline it: its left-handed bundles keep the
`_rightHanded` tests and the small same-module right-handed helpers (`_toRightHandedCameraWorld`…).
They behave the same, they are just not byte-identical.

The published `lib/` modules import the bare specifier `#coordinate-system`, so they need a bundler
that reads `package.json` `imports`; native browser ESM cannot resolve it. The prebundled
`dist/index.js` has no such import.

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
  in `std-mirrored-support.ts` is inverted. glTF meshes, which keep glTF's winding (see below), stay
  `"ccw"`: the primitive feature marks each of them with mesh-feature bit 11 (`_primitiveFeatures`), and
  every material path reads that per-mesh mark — PBR through its per-mesh winding, Standard through bit
  11 of its mesh-feature key, Node through `_pipelineForCcwMesh` (its renderables never group marked and
  unmarked meshes, even when they share one geometry), and shader materials by splitting glTF and
  procedural meshes into separately wound pipelines (`|ccw` variant key). The mark lives on the mesh,
  not on its shared GPU geometry: a negative-scale node instancing the same glTF mesh is not marked and
  stays `"cw"`, and a device-loss rebuild of the geometry keeps it. Whenever a PBR or Standard
  renderable is built, the `enableMirroredMeshes()` opt-in clears that bit in a left-handed build;
  right-handed, it rewrites it from the live determinant instead, so a glTF mesh moved from PBR or
  Standard to a Node or shader material keeps its `"ccw"`. Otherwise Node and shader materials read the
  load-time mark, as in a left-handed build. Depth and shadow passes use the same
  winding as the colour pass, since light views mirror like the camera's.
- **glTF** — the loader keeps glTF's native right-handed space: the `__root__` node has no X mirror,
  `computeNodeWorldMatrix` drops the root conversion, the skeleton and animation-mixer root transforms
  (`skeleton-pose.ts`, `skeleton-updater.ts`, `weighted-gltf-mixer.ts`) are the identity to match, the
  glTF camera fixup keeps +X, and the primitive feature module (per-mesh winding) is always loaded.
  `Mesh._authoredSign` stays `-1`: it is relative to the left-handed rule, which the right-handed
  winding in `std-mirrored-support.ts` already inverts. Gaussian splats from
  `KHR_gaussian_splatting` replace the left-handed `rotation.z = π` (which, combined with the root
  mirror, equals a Y mirror) with `scaling.y = -1`, since there is no root mirror to combine with.
- **Environment** — `rotateY` in the PBR IBL helpers (and the mesh-LoD copy) negates Z after the
  rotation, like Babylon.js's `REFLECTIONMAP_OPPOSITEZ`, for radiance, irradiance, clearcoat and local
  cubemaps.
- **Normal mapping without tangents** — the PBR cotangent frames (base normal map, clearcoat normal
  map, mesh-LoD copy) reverse both their tangent and bitangent, like Babylon.js's
  glTF loader, which ties `invertNormalMapX/Y` to the handedness. Standard and node materials keep
  their frames: Babylon.js flips those only on explicit options.

- **Everything else** — each Babylon.js `useRightHandedSystem` branch reachable from a Lite feature has
  its counterpart: light views of shadow maps and cascades, the linear-depth pass, Standard skybox and
  reflections (`REFLECTIONMAP_OPPOSITEZ`, spherical mapping), the PBR cubemap skybox and background
  ground, shader-material system uniforms (`view`, `viewProjection`, … are handed to user shaders as
  Babylon.js's right-handed matrices), the derivative normal view, node-material `View`/`Projection`
  inputs and PBR helpers, billboard and billboard-picking texture U, camera inputs, gizmos, the
  geospatial camera, `.babylon` cameras, glTF cameras, interactivity
  camera paths, the procedural sky, CSG2, Havok mesh shapes, USD roots and normal maps, the
  screen-space raymarch normal reconstruction behind contact shadows and SSGI (its `cross` operands
  swap, like the derivative normal view behind cavity), the mesh-blending inverse view, and WebXR
  (poses, pointer, teleport, hand meshes, controller models), which stays in WebXR's native
  right-handed space instead of being Z-mirrored.
- **Not ported: `EXT_lights_image_based`** — `envYawFromQuaternion` returns the left-handed yaw −A in
  both builds, so a right-handed build samples the environment along `Sz·Ry(−A)·d`. Babylon.js's loader
  inverts the extension's rotation only when left-handed, i.e. samples `Sz·Ry(A)·d` when right-handed:
  the two agree only for A = 0° or 180°. Flipping the sign alone did not reproduce Babylon.js's
  right-handed render of scene 265 either (the irradiance still differs), so the port stays open, and
  twin 342 (A = 90°) is compared with scene 265's left-handed reference (`BJS_RH_BROKEN`).

Files whose handedness-sensitive code needs no seam are listed, with the reason, in `HANDEDNESS_EXEMPT`
of `tests/lite/unit/handedness-guard.test.ts` (orthographic projection, text, glTF primitive winding,
node and Standard bump frames, the PBR anisotropy direction — both tangent axes would reverse and the
lobe is quadratic in them — and the flat normal, which is re-oriented toward the viewer).

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
  that they stay pure re-runs. A Babylon.js 9.28 right-handed bug is worked around on the
  reference side: `right-handed-twin.ts` replaces the zero refraction matrix of an unrotated
  `CubeTexture` (twin 334). Twin 342 keeps scene 265's left-handed reference (`BJS_RH_BROKEN`)
  because Lite does not port `EXT_lights_image_based` yet (see above). Their specs recapture the
  Babylon.js reference on the test browser on every run (`captureGolden({ force: true })`, as specs
  165, 212 and 214 do): the committed goldens were captured on another GPU and only seed the gallery
  thumbnails, while CI renders on BrowserStack's macOS GPU.
- Two twins carry a looser `maxMad` than their source scene, set from measured runs: 323 (0.01 vs
  scene 13's 0.008) measured 0.0089, where Babylon.js right- vs left-handed differ by 0.779 and Lite by
  0.782, i.e. noise; 328 (6.4 vs scene 250's 6.1) measured 6.21. Scene 250 has no skybox, but its PBR
  windows reflect the environment map, and scene 250's known Lite gap (over-bright window reflections,
  absent in Babylon.js) moves with the mirrored view onto the larger right tower: Lite right- vs
  left-handed differ by 7.5, Babylon.js by 5.3.

Also:

- `tests/lite/unit/right-handed-system.test.ts` and `right-handed-seams.test.ts` — view matrices
  against Babylon.js `LookAtRH`, camera world matrices and per-seam values (shader-material system
  uniforms included). Front-face winding of glTF against procedural geometry on Standard, Node and
  shader materials is asserted by the "glTF winding on non-PBR materials" pairs in
  `right-handed-pairs.test.ts`.
- `tests/lite/unit/coordinate-system-variants.test.ts` — both variants and the `imports` map.
- The `build` test project bundles the published `build/lib`, where `#coordinate-system` stays a
  bare specifier. Bare Rollup does not read `imports`, so its harness resolves the specifier with
  `packageImportsPlugin()` (`tests/lite/build/bundler-harness.ts`), as `@rollup/plugin-node-resolve`
  does for a consumer; webpack reads the map natively.
