# Module: Independent Ambient-Occlusion References

> Test-only paths: `scripts/ao-reference/`, `reference/lite/ao-reference/`.
> No imports from the BLite runtime and no additions to its public API.

## Purpose

This is historical reference infrastructure, not the supported runtime API.
The BLite implementation now ships XeGTAO only; VBAO's native comparison
fixtures and source pins remain immutable evidence of the earlier evaluation.
Current WGSL validation compares only XeGTAO against its native buffers.

Establish an independent, reproducible oracle before implementing XeGTAO or
visibility-bitmask AO in BLite. The user explicitly approved comparing these
algorithms against their own references instead of Babylon.js SSAO2.
`GUIDANCE.md` and existing Babylon reference images remain unchanged.

This milestone generates algorithm fixtures, not numbered lab gallery scenes.
Its lossless previews and binary goldens live under `reference/lite/`.
The feature's eventual WebGPU integration, material composition, temporal
filtering, MSAA, orthographic support, and gallery scenes are separate work.

## Public API Surface

There is no engine API. The test utilities expose:

```ts
type AoFixtureId = "plane" | "corner" | "box-contact" | "sphere-contact" | "thin-occluder" | "screen-edge" | "tilted-plane-x" | "tilted-plane-y" | "depth-step";

interface AoFixtureSettings {
    width: number;
    height: number;
    near: number;
    far: number;
    tanHalfFovY: number;
    radius: number;
    thickness: number;
    slices: number;
    steps: number;
}

interface AoFixture {
    id: AoFixtureId;
    settings: AoFixtureSettings;
    depth: Float32Array;
    normals: Float32Array;
    mask: Uint8Array;
    raytraced: Float32Array;
}

function createAoFixture(id: AoFixtureId): AoFixture;
function compareAoValues(actual: Float32Array, expected: Float32Array, mask?: Uint8Array): { meanAbsolute: number; maximumAbsolute: number; pixels: number };
```

Commands:

- `pnpm reference:ao --update`: explicitly generate or replace these new AO
  fixtures and their goldens. Never replaces existing Babylon goldens.
- `pnpm reference:ao --check`: run the independent native reference again into
  an ignored directory and check reproducibility without modifying goldens.
- `pnpm exec vitest run --project unit tests/lite/unit/ao-reference.test.ts`:
  offline, cross-platform fixture-integrity and contract checks.

Generation requires Windows and PowerShell 7, a D3D11 feature-level-11 GPU, and
OpenGL 4.3. PowerShell's built-in C# compiler builds a small managed native host;
no Visual Studio installation, Unity, Filament engine build, shader transpiler,
or native reference executable is shipped with BLite.

## Internal Architecture

### Independence and source provenance

The source manifest pins repository, complete commit SHA, path, and SHA-256 for:

- Intel XeGTAO `XeGTAO.h`, `XeGTAO.hlsli`, and its MIT license.
- Filament `gtaoImpl.fs`, `geometry.fs`, `common_math.glsl`, and its Apache license.

Downloads are stored in `.ao-reference-cache/`, never in the engine bundle.
Cached bytes are reverified before use. A failed download or hash mismatch stops
generation. Licenses accompany the downloaded source.

Intel's original HLSL functions execute on D3D11. The integration wrapper only
declares bindings, supplies constants/normals/noise, selects the fixed quality
preset, dispatches the original functions, and defines neutral background output.
It does not contain a reimplementation of the AO estimator or denoiser.
The system FXC compiler cannot parse DXC's integer-literal swizzles. Assembly
expands exactly the three verified `groupThreadID.xy % 2.xx` / `4.xx` / `8.xx`
expressions into equivalent `uint2` constructors and the denoiser's `1.xxxx`
into `float4(1, 1, 1, 1)`; no arithmetic changes.
Missing or duplicated occurrences are an error. Cached upstream bytes stay intact.

Filament's original GLSL `groundTruthAmbientOcclusion` executes in a hidden,
owned OpenGL context with visibility bitmasks enabled and bent normals disabled.
The native host does not inspect, focus, or interact with any user application.
Necessary position-reconstruction and `acosFast` function bodies are extracted
unchanged from the pinned upstream sources. Material-parameter declarations,
sampling an already-linear depth texture, and output bindings are adapter code.

The fixture manifest identifies the VBAO result as **Filament's estimator with
XeGTAO-preprocessed depth**. It is deliberately not described as stock Filament
whole-frame parity. VBAO has its own raw, unfiltered golden; XeGTAO has raw packed
AO, edges, depth mips, and its upstream denoised result. No unimplemented hybrid
denoiser or temporal stage is presented as validated.

### Separately labeled slope-safe VBAO variant

The user approved adding a sampling variant without replacing the original
goldens. `vbao-slope-safe.f32` / `vbao-slope-safe-golden.png` are **adapted results**,
not an independent upstream oracle. They execute the unchanged upstream
estimator but replace its base-level sampling adapter.

Native experiments established that the original nearest-depth sampler pairs
one texel's depth with a different, fractional sample ray. On oblique planes this
creates false above-surface samples. The effect reproduces with Filament's
original depth convention and rotated-grid mip reduction, and persists with
exact `acos` or mip sampling disabled.

The variant interpolates **reciprocal view depth** only when the four bilinear
support texels are valid geometry, have matching normals, and their reconstructed
positions lie on the same tangent plane within floating-point tolerance.
Reciprocal depth is affine in screen coordinates on a perspective-projected
plane, unlike view depth itself. It therefore reconstructs the plane at the
requested sample ray without a radius-dependent bias.

At silhouettes, depth steps, normal discontinuities, and unsupported mip levels,
sampling stays point-sampled. It never
mixes foreground and background depths. No blur or arbitrary origin offset is
introduced. Mip levels above zero retain upstream sampling because XeGTAO's
weighted mip texels do not necessarily represent one exact tangent plane.
At a screen border, a clamped two-by-two footprint may extrapolate reciprocal
depth only after passing the same coplanarity test. This keeps the sampled
position on the known edge plane rather than extending a constant clamped
depth along a different ray. Extrapolations behind the camera are rejected.

This is a reference-side quality prototype, not the BLite runtime implementation
or a proven performance improvement. It incurs additional depth/normal reads.
The estimator's conservative sector rounding remains, including approximately
one sector of flat-plane occlusion; that separate bias is not silently removed.
The gallery must show upstream VBAO and slope-safe VBAO as different columns.
`vbao-slope-safe-samples.f32` is a direct native sampling probe, at
`uv + 0.25 * texelSize`, not an AO image. Tests compare it against the analytic
tilted-plane ray intersection and against exact point depths at two parallel
planes' discontinuity. This catches incorrect interpolation even when angular
sector quantization happens to hide it in the final AO image.

### Canonical inputs

Inputs are deterministic analytic ray intersections with planes, boxes, and
spheres. Pixel-center rays originate at the view-space camera origin.

- Canonical view coordinates: X right, Y up, Z forward, perspective projection.
- Storage: row 0 is the top row, tightly packed, little-endian.
- Reverse-Z depth: `near * (far / z - 1) / (far - near)`; background is zero.
- Normal: four f32 components per pixel, xyz unit view normal and w = 0.
- Receiver mask: one byte per pixel, 1 for geometry and 0 for background.
- Default resolution: 128 x 96, both divisible by 16 for upstream preprocessing.
- Near/far: 0.1 / 20; vertical FOV: 60 degrees.
- Radius: 0.6 view units; constant VBAO thickness: 0.25.
- Three slices, three samples per slice side; static sampling phase.

The Filament adapter reflects Z to its negative-forward view convention,
reflects normal Z accordingly, and supplies position parameters
`(2 * tanHalfFovX, 2 * tanHalfFovY)`. Its upstream slice directions assume
bottom-up OpenGL UVs, so the host reverses rows on upload and readback. Both
exported native outputs retain the canonical top-down ordering. These
reference-backend conversions do not change BLite's texture conventions.

### Outputs and manifest

Each fixture contains `depth.f32`, `normals.f32`, `mask.u8`, independent
cosine-weighted ray-traced AO, five XeGTAO depth mips, raw packed XeGTAO AO,
packed edge values, decoded denoised XeGTAO AO, raw VBAO visibility, adapted
slope-safe visibility, and the direct slope-safe depth sampling probe.

Native storage uses f32 depth and shader arithmetic. XeGTAO's original working
AO packing scale of 1.5 and native `R8_UINT` working/final targets are preserved;
using `R32_UINT` instead changes the final overflow conversion. Raw bytes are
expanded losslessly into u32 fixture words. Decoded final AO
and VBAO use visibility: 1 means unoccluded, 0 means occluded. Background is 1.

Lossless grayscale PNGs encode `round(clamp(visibility, 0, 1) * 255)` directly,
without image processing, exposure, tone mapping, or PBR lighting.
The manifest records source pins, settings, algorithm identities, native backend
information, generator/adapter hashes, file sizes and hashes, and geometry-mask
coverage. No timestamps or randomly generated scene data affect reproducibility.

## Pipeline Configuration

XeGTAO uses the original three logical stages:

1. `XeGTAO_PrefilterDepths16x16`: reverse-Z input -> five view-depth mip levels.
2. `XeGTAO_MainPass`: depth mips + normals + original Hilbert/R2 noise ->
   working AO and edges.
3. `XeGTAO_Denoise`: one original final spatial denoise pass -> final AO.

VBAO reads the same view-depth mip data, converted to negative-forward depth.
Its original estimator evaluates 32 angular sectors per slice. It has no
temporal accumulation or stock Filament post-filter in this milestone.

## Shader Logic

All estimator/filter mathematics come from verified upstream shader bytes.
The reference wrapper must never import production WGSL or BLite camera,
normal-reconstruction, AO, or post-processing helpers.

The independent CPU quality reference samples 256 cosine-weighted hemisphere
rays per receiver using a deterministic Hammersley sequence. A ray contributes
occlusion if it intersects actual fixture geometry within the configured radius.
It is a finite-sample quality reference, not an exact parity target for a
screen-space algorithm. Missing hidden geometry and algorithm heuristics are
expected to produce differences.

## State Machine / Lifecycle

1. Validate CLI arguments and requested operation.
2. Fetch/verify upstream source files and retain their licenses.
3. Generate deterministic input fixtures into the ignored staging directory.
4. Compile and execute the native reference host; fail on unsupported APIs,
   shader compilation errors, invalid dimensions, or native failures.
5. Validate exact output shapes, finite values, valid ranges, and neutral
   background before producing previews.
6. Verify preserved-original hashes and settings against `upstream-lock.json`.
   The original six fixtures are immutable even during `--update`.
7. Update only on explicit `--update`; `--check` never writes goldens.
8. Release native GPU objects and the hidden native window, including on failure.

## Babylon.js Equivalence Map

Not applicable. These are independently authorized AO references.
All existing Babylon parity tests and references remain intact.

## Dependencies

Existing Node/TypeScript tooling, `pngjs`, PowerShell 7/.NET, Windows D3D11,
the system HLSL compiler, and the GPU's OpenGL driver.
Native and downloaded-source dependencies are reference-generation-only.

## Test Specification

Offline unit tests verify deterministic fixtures, analytic intersections,
projection/depth round trips, unit normals, exact buffer dimensions, byte order,
comparison behavior, source-pin validation, and every checked-in artifact hash.
They also assert finite/range invariants and meaningful non-flat occlusion.
The ray-traced plane is exactly unoccluded. The upstream shader results are not:
XeGTAO's fast-angle approximation and VBAO's sector rounding introduce a small
flat-plane bias. Preserve it in the correctness oracle; report its error against
ray-traced AO instead of changing upstream mathematics or claiming exact
physical correctness. The plane sanity check limits mean error to 0.05, not the
worst single-pixel error. No existing scene threshold is changed.

The separately adapted variant adds whole-image tilted-plane checks: mean
self-occlusion below 0.04, maximum below 0.07, and a reduction of at least 30%
relative to the original. These include screen borders, not a convenient crop.
It retains nontrivial corner occlusion. Native sampling-probe checks verify
actual ray depths to relative error below `2e-6` and exact foreground/background
depths at a parallel-plane discontinuity, where a normal-only guard would fail.
For the current tilted fixtures, mean self-occlusion drops from approximately
0.080 to 0.032; most of the residual is the unchanged sector-quantization bias.
This does not establish that VBAO outperforms XeGTAO overall.

Native validation generates twice and checks reproducibility. Reference identity
and fixture inputs must match exactly. Cross-GPU floating-point tolerances for a
future BLite comparison must be established from measurements, not by loosening
existing scene ceilings. Quality error against the ray-traced reference is
reported separately from implementation parity.

## File Manifest

- `scripts/ao-reference/sources.ts`: pinned sources and shader assembly.
- `scripts/ao-reference/fixtures.ts`: geometric inputs and CPU quality reference.
- `scripts/ao-reference/compare.ts`: strict buffer comparisons and preview encoding.
- `scripts/ao-reference/vbao-slope-safe-sampling.glsl`: clearly identified sampling adaptation, never substituted into upstream goldens.
- `scripts/ao-reference/native.cs`: independent D3D11/OpenGL execution and readback.
- `scripts/ao-reference/capture.ps1`: compile and invoke the native host.
- `scripts/ao-reference/generate.ts`: explicit generation/check CLI and provenance.
- `tests/lite/unit/ao-reference.test.ts`: offline checks.
- `reference/lite/ao-reference/`: manifest, float fixtures, and lossless previews.
- `reference/lite/ao-reference/upstream-lock.json`: original six fixtures' source/settings/artifact provenance, never rewritten by generation.
