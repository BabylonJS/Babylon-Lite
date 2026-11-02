# Diligent Kitchen comparison

## Purpose and provenance

Import `DiligentGraphics/USDAssets/Kitchen.usd` at commit
`c823af8961047f4642c985c37338b18a35b6b017`, Git blob
`f0cddb55f5f7b2c246f32978ddde4d0cf797160a` (4,289,711 bytes).
Preserve the repository's Apache-2.0 license and source attribution alongside
the converted GLB. The source is Y-up, centimetres (`metersPerUnit=0.01`), with
1,788 meshes, 275,656 polygons and 536,949 triangulated faces. It has no authored
normals, camera or external asset dependencies.

The USD-to-glTF conversion preserves authored transforms, including the root's
rotation. Apply the USD unit scale exactly once, then join compatible static
meshes with transforms baked. Verify triangle counts and world bounds before
and after optimization. Do not invent textures or claim original Hydrogent
material parity. Preserve the original `COLOR_0` vertex colors and use a white
nonmetallic PBR base factor so they are not tinted. After optimization, the GLB
assigns one explicit material (white base color, `metallicFactor` 0,
`roughnessFactor` 0.9) to every primitive; without it glTF consumers fall back
to the metallic default material. Lite and Babylon.js scenes still assign their
own equivalent material. No source geometry is
removed. Optimization verifies an index-weighted color histogram before and
after joining/welding, in addition to triangle counts and bounds. Record its
SHA-256 and colored-triangle count in the asset manifest.

## Tooling and files

Missing conversion dependencies are isolated under `.ao-reference-cache/kitchen`,
not installed into the project or a global Python environment.
`usd2gltf==0.3.5` and `usd-core==26.11` perform USD decoding; glTF Transform
4.3.0 performs static optimization. Asset preparation verifies the pinned Git
blob before conversion and writes hashes, counts, units and bounds into the
asset manifest. The converted `kitchen.glb` is hosted in BabylonJS/Assets under
`meshes/DiligentKitchen/` (with its Apache-2.0 `LICENSE` and a README listing the
modifications), not in this repository. `pnpm fetch:ssao-kitchen`
(`scripts/fetch-ssao-kitchen.ts`) restores it from a pinned Assets commit into the
git-ignored `lab/public/ssao-comparison/kitchen.glb`, verifying size and SHA-256
against the checked-in `kitchen-source.json` even on cache hits. The demo bundle
build (demo fetcher `ssao-kitchen`), `pnpm reference:ao:kitchen` and the Kitchen
temporal capture run it automatically. The license and provenance manifest stay
checked in beside it. The comparison-only demo bundle copies that directory beside
its entry. The GLB structure unit test runs only when the file is present.
The pin is the merged Assets commit `0f2240a3819007ce3aa92f22f0955f0f20dbbe59`;
the published GLB was independently downloaded and checked against the manifest.

Reproduce the asset on Windows with Python 3.13 and Node available:

```powershell
pwsh -NoProfile -File scripts\ao-reference\prepare-kitchen.ps1 -Bootstrap
```

`-Bootstrap` is needed only for missing or mismatched cache-local tools. It never
changes workspace dependencies or a global Python installation. Without it,
missing tools produce an explicit error. The source Git blob and license SHA-256
are checked before conversion; cached downloads are not trusted implicitly.
The tool versions are usd2gltf 0.3.5, usd-core 26.11, NumPy 2.5.4, gltflib 1.0.13
and glTF Transform core/functions 4.3.0. Optimization welds only bitwise-identical
vertices, not approximately coincident geometry.

## Interactive scene

Add Kitchen to the existing comparison preset list. A shared high-level helper
loads the same GLB, preserves its vertex colors and creates a deterministic interior
camera, and is reused by the native-reference capture client. The interactive
page continues to compare BLite against PR839; it must not label a WGSL port or
PR839 as native DiligentFX.

`createKitchenScene(engine: EngineContext, scene: SceneContext, url: string):
Promise<ArcRotateCamera>` loads the asset, overrides mesh materials with a PBR
base factor `[1, 1, 1, 1]`, metallic 0 and roughness 0.9, then adds it to
the scene. It also adds the common hemispheric light (direction `[0,1,0]`,
intensity 0.5) and directional light (`[0.3,-1,0.45]`, intensity 1.1), shared by
interactive and recorded views. The shared camera is alpha 1.8, beta 1.4, radius 1.5, target
`[0, 1.3, 0]`, near 0.05 and far 20. The USD has no authored camera: this is a
chosen interior view, not a reconstruction of the website's screenshot camera.
`moveKitchenCamera(camera: ArcRotateCamera, offset: number): void` sets alpha
to `1.8-offset` and beta to `1.4+offset*0.1`.

## Matched native reference

Extend the existing AOF1 capture contract with an optional Kitchen scene.
Old sphere captures and their behavior remain unchanged. Kitchen uses a bounded
camera orbit, hold, reverse and rest; geometry is static. Capture current/previous
camera matrices, raw device depth, world normals, NDC motion, noisy AO,
accumulated AO and final AO. Record the asset and capture-code hashes.
Kitchen additionally renders an RGBA8 color target in that same geometry pass,
without AO applied, and saves each frame through a size-bounded, hash-verified
`/diligent-color/<index>` endpoint. Color is a separate gzip file and does not
change the AOF1 binary layout or legacy sphere captures.

For Kitchen, decode the captured RGBA16 encoded world normals into signed
RGBA16 with explicit nearest-even conversion before BLite estimation.
The native adapter decodes the same bytes. Compare a hash of the GPU-decoded
normal bytes against the exact CPU bytes uploaded to D3D11 to establish the
same normal input, rather than merely similar view-space normals.
Check these hashes on every recorded frame, not only the first. Permit only
FP32 normalization roundoff of at most `2^-23` outside the encoded `[0,1]`
range; do not clamp or accept invalid normals. The signed half-float bytes
still have to match exactly. A capture-only compute task decodes normals with
explicit nearest-even half conversion, runs between geometry and AO, and owns
one RGBA16 storage texture. Scene/demo setup does not access GPU internals.

Replay the original pinned DiligentFX HLSL graph through the existing D3D11
hardware reference, including its own estimation and complete denoising.
Run it twice and require identical outputs. A separate shared-noisy-input lane
may help distinguish estimator and denoiser differences, but is labelled as such.
The modified clipping lane is not an upstream reference.

Kitchen validation is geometric, not sphere-specific: check native reconstructed
world positions, signed unit normals, static-world camera-motion vectors,
finite AO ranges, neutral background and complete nontrivial scene coverage.
Never reuse the old moving-floor metrics as Kitchen quality scores.
Native history ages must be finite and nonnegative; native noisy, accumulated,
final AO and history must be byte-identical across the two replays. Reject
position reconstruction error above 0.002 m or NDC motion error above 0.0005.
At least one full frame's worth of foreground samples and 100 nontrivially
occluded samples are required. The immutable spatial host is checked against
its existing golden provenance; LF/CRLF normalization is permitted only when
canonical CRLF content matches the original hash. No golden is regenerated.

## Viewer and limitations

Publish a separate recorded Kitchen viewer with synchronized stages and frames.
Show BLite, original DiligentFX and optionally the original denoiser fed the same
BLite noisy AO. Identify the fixed shader commits, asset hash, resolution,
radius/falloff/sampling, full reconstruction, camera path and backend.
No display-gain adjustment, extra blur or lighting/tone-map difference is used.
The version-2 viewer displays the original colors by default. An `AO only`
checkbox switches every panel to unmodified grayscale AO. Color mode multiplies
each lane's AO into the exact same captured color image with Canvas2D's multiply
composition; it is presentation-only and cannot change the SSAO inputs/history.
Color/frame/stage changes are committed atomically across panels.
The checked **Enable SSAO** control bypasses the recorded AO when unchecked:
display only the common original color, or white when **AO only** is checked.
All three panels switch together without seeking or changing their recorded
frames/history. Do not fetch AO images while bypassed; retain the selected
stage but disable its selector until SSAO is re-enabled. This display bypass
does not imply a native rendering-performance measurement.
The Kitchen replay is full resolution in both implementations; the existing
reference adapter does not certify native Half mode.

Playback FPS is not rendering performance. Do not report the instrumented
readback/file-writing native replay as a GPU benchmark. Existing live task timings
on the interactive scene remain separate.

Generate and view the full capture:

```powershell
pnpm reference:ao:kitchen
# /ao-temporal-reference/kitchen.html on the lab server
```

The bounded default is 960x540, 32 warmup frames, 24 forward steps of 0.01 rad,
8 held frames, 24 reverse steps and 8 rest frames (96 total, simulation 60 Hz).
`--smoke` uses 320x240 and 24 frames, publishing `kitchen-smoke.html` separately.
The legacy sphere-only fixed-pose mean is explicitly unavailable in Kitchen.
Both are Full, High estimation, radius 0.6, falloff 0.615, radius multiplier
1.457, mip offset 3.3, temporal stability 0.9 and reconstruction radius 4.

`comparison.json` contains the scene/adapter/source hashes, shader commits,
camera angles, source asset manifest, backend and geometric validation results.
Each timestamped capture has lossless PNGs for BLite and native raw/temporal/final
AO, shared-input temporal/final AO and one common color PNG per frame.
The third panel's raw view intentionally
shows the same BLite noisy image, since that is its actual input. Stages and
frames update atomically across panels; scrub/step controls pause playback.
Frames simulate 60 Hz; default 30 Hz playback is labelled 2x slow motion.
The existing historical `complete-port/index.html` is not overwritten.

## Validation scope

Use focused asset/contract tests, type/lint checks, one debug comparison bundle
and bounded native/WebGPU captures. No all-scene build, parity suite, golden,
ceiling or historical reference mutation is required.

## File manifest

- `lab/lite/src/shared/kitchen-scene.ts`: public-API-only asset/camera setup.
- `lab/public/ssao-comparison/`: provenance and original license (checked in); runtime GLB restored by `scripts/fetch-ssao-kitchen.ts`.
- `scripts/ao-reference/prepare-kitchen.ps1`, `optimize-kitchen.mjs`: pinned conversion.
- `scripts/ao-reference/diligent-normal-input.ts`: exact normal decode task.
- `scripts/ao-reference/diligent-{contract,capture-client,reference}.ts`: optional
  Kitchen capture, unchanged AOF1 layout and reusable native runner helpers.
- `scripts/ao-reference/diligent-native.{cs,ps1}`: original HLSL host, per-frame
  normal upload hashes and line-ending-independent immutable-host verification.
- `scripts/ao-reference/kitchen-reference.ts`, `kitchen-viewer.html`: validated
  native replay and synchronized recorded viewer.
- `tests/lite/unit/kitchen-reference.test.ts`, `diligent-reference.test.ts`,
  `ssao-comparison.test.ts`: asset, bounded capture and preset contracts.
