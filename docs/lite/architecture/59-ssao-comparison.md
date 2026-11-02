# SSAO comparison demo

## Purpose and baseline

`demo-ssao-comparison.html` compares this branch's XeGTAO implementation with
the unmodified horizon-based implementation in the **unmerged** public
[BabylonJS/Babylon-Lite#839](https://github.com/BabylonJS/Babylon-Lite/pull/839).
The baseline is pinned to commit
`29b75909635efc1d6d15795da561a78cced5fc19`, not a moving branch and not master.

The comparison uses one current engine, scene, camera, animation clock, and
color/depth render target. It is an algorithm comparison, not a comparison of
two engine versions. The build downloads three original baseline modules into
the ignored `.ao-reference-cache` directory and checks their Git blob hashes.
Their relative engine imports resolve to this checkout; their local raymarch
and temporal imports resolve to the pinned baseline modules. No baseline code
is rewritten, merged into the package, or exposed through a new package export.
The source is Apache-2.0, like this repository.
The pinned temporal helper expects a newer internal render-target size export.
Only in this comparison build, expose the current engine's existing private
`resolveSize` under that internal name. Its behavior and source file on disk
are unchanged; all comparison targets use the current fixed/surface descriptors.

## Configuration and helper API

The demo adds no engine API. Its shared configuration contract is:

```typescript
type ComparisonScene = "contacts" | "layers" | "motion" | "cornell";
type ComparisonAlgorithm = "current" | "existing";
type ComparisonMode = "split" | "single";
interface SsaoComparisonConfig {
    scene: ComparisonScene;
    algorithm: ComparisonAlgorithm;
    mode: ComparisonMode;
    aoOnly: boolean;
    enabled: boolean;
    temporal: boolean;
    normals: boolean;
    half: boolean;
    reconstruction: "full" | "half";
    pruning: boolean;
    quality: "low" | "medium" | "high" | "ultra";
    radius: number;
    intensity: number;
}
function parseSsaoComparisonConfig(params: URLSearchParams): SsaoComparisonConfig;
function comparisonPassSelection(config: Pick<SsaoComparisonConfig, "algorithm" | "mode" | "normals" | "temporal" | "enabled">): {
    current: boolean;
    existing: boolean;
    geometry: boolean;
    color: boolean;
    timing: boolean;
};
```

Defaults are `contacts`, `current`, `split`, all booleans true, `high`,
radius 0.6 and intensity 0.5. Boolean URL fields use exactly `0`/`1`; `ao` maps to
`aoOnly`. Reject unknown enums, invalid booleans, empty/nonfinite numbers, radius
outside [0.05, 2] and intensity outside [0, 1]. The divider starts at 0.5 and is
an interactive [0, 1] control rather than a URL field.
`enabled` defaults to true and is controlled by `ssao=0|1` and the checked
**Enable SSAO** checkbox. When disabled, both AO tasks, both relay copies and the
geometry/MRT producer are skipped; only the ordinary scene-color producer and
common compositor run. The compositor returns visibility 1 without sampling
either AO texture, and hides the split divider. Color mode shows the original
unoccluded scene; AO-only mode is uniformly white. Re-enabling invalidates both
histories and timing samples, so stale camera/object poses cannot be resumed.
The disabled state survives configuration reloads.
Reconstruction defaults to `full`, preserving the existing Half estimator mode.
`reconstruction=half` explicitly selects the reduced geometry/denoising/history
pipeline described in [module 60](60-ssao-half-pipeline.md), with full-size
edge-aware output. Unknown reconstruction values fail at configuration parsing.

`current = enabled && (split || algorithm === current)`; `existing = enabled &&
(split || algorithm === existing)`; `geometry = current && (normals || temporal)`; `color = !geometry`;
`timing = single`. Absent geometry always uses the ordinary color producer.

The build helper exports `comparisonGitBlobHash(bytes: Uint8Array): string`,
`prepareComparisonBaseline(root: string): Promise<string>`,
`comparisonBaselineImport(root: string, snapshot: string, source: string,
importer: string): string | null`, `comparisonSizeExport(code: string): string`,
and `comparisonBaselinePlugin(root: string): Promise<Plugin>`. Git hashes include
the canonical `blob <byteLength>\0` prefix. Only missing cache entries are
downloaded; a corrupt cached blob is an error, not an automatic overwrite.
Relative dependency mapping is bounded to the engine source directory.

## Scenes

- **Contacts:** sphere/floor contact, stacked blocks, wall corners and gaps.
- **Layers:** thin rails, overlapping panels, separated surfaces and depth edges.
- **Motion:** moving sphere plus the shared green skinned and purple morphed beams.
- **Cornell Box:** the same checked-in model used by the existing screen-space
  effects demo; its background plane is hidden in both implementations.

Each preset defines its camera and geometry once. Switching presets reloads the
page with the selected configuration so resource lifetimes and initial history
are unambiguous. Animation pause holds the pose but continues AO accumulation.

The non-Cornell camera uses alpha `-PI/2.7`, beta 1.08, target (0, 0.9, 0)
and radius 8.5 (7.4 for Layers). Cornell uses alpha `PI/2`, beta 1.35, radius
5.3 and target (0, 1.2, 0). All cameras use near/far 0.1/40.
Use hemispheric light [0, 1, 0] at intensity 0.5 and directional light
[0.3, -1, 0.45] at 1.1; Cornell uses 0.12/0.3 plus a point light at (0, 2.9, 0)
with intensity 1.6.

Procedural presets share an 8x6 ground, back wall centered at (0, 1.5, 2.6)
scaled (8, 3, 0.12), and side wall at (-3.8, 1.5, 0) scaled (0.12, 3, 5.2).
Use rough PBR materials (metallic 0, roughness 0.9), with gray RGB
(0.65, 0.65, 0.65), blue (0.1, 0.3, 0.6) and orange (0.65, 0.22, 0.065).
Contacts/Motion share stacked cubes at (-1.2, 0.6, 0.8), scale (1.2, 1.2, 1.2),
and (-1.2, 1.6, 0.8), scale (0.8, 0.8, 0.8); a panel at (1.3, 0.6, 1.85),
scale (1.7, 1.2, 0.12); and a diameter-1.5 sphere at (1.3, 0.75, -0.2).
Contacts adds two 0.6x0.5x0.6 blocks at x/z (2.5, -0.8), y 0.25/0.82.
Motion instead loads the existing `createAoDeformationExamples` asset and
animates sphere x as `1.3 + sin(seconds) * 0.7`.

Layers adds ten rails centered at (-2.4 + i*0.34, 0.5, 0.8), scale
(0.055, 1, 1); four plates at (1.7, 0.2 + i*0.26, 0.3), scale (1.5, 0.045, 1.6);
a 0.35-radian Y-rotated panel at (-0.7, 0.8, -1.2), scale (2.4, 1.6, 0.055);
and a block at (0.7, 0.35, -1.55), scale (0.8, 0.7, 0.8).
Cornell loads `screen-space-effects/cornellBox.glb`.

Camera sweep changes alpha/beta by `sin(seconds*0.8)*0.15` and
`sin(seconds*0.6)*0.03` relative to the preset. Reset zeroes both clocks,
restores camera/target/inertial offsets, restores sphere x, and seeks each
deformation group to frame zero through `goToFrame`. It preserves animation
play/pause state.

## Shared inputs and minimal producers

The common color/depth target uses single-sample color and `depth32float`.
When XeGTAO needs normals or velocity, a geometry task writes its requested MRTs
**and the real scene color into that same target**. Its external depth attachment
is the common target. Otherwise a regular render task produces color/depth.

In A/B mode only the selected algorithm and its producer run. The existing
algorithm needs only the color/depth producer. XeGTAO requests only the optional
attachments enabled by the configuration: view normals, and RGBA16F velocity
with previous positive view depth when temporal filtering is enabled. Half-float
velocity halves producer bandwidth (Kitchen 1080p producer about 0.23 to 0.17 ms);
the temporal owner switches to f16 tolerances and substitutes the exact static
camera depth, so static receivers lose no precision (see module 58).
With neither input it also uses the regular color/depth producer.

In split mode the geometry producer runs once if required, and both algorithms
consume the **same actual depth attachment in the same frame**. Both outputs
retain full-viewport UVs; the divider crops them rather than changing projection,
aspect ratio, receiver density or animation pose.

## Output interpretation and composition

XeGTAO outputs visibility (`1` unoccluded). The baseline outputs occlusion amount
in the red channel of `rg16float` (`0` unoccluded; green is view distance).
Normalize the latter to visibility using `1 - occlusion`. Apply a user-requested
3x display gain to baseline occlusion, without changing its pinned estimator.

Public copy tasks relay both outputs into surface-sized RGBA16 render-target
texture facades. The baseline uses the same linear enlargement as its native
multiply composite. A public fullscreen effect displays normalized grayscale
visibility or multiplies **the same unoccluded scene color** by that visibility.
This intentionally compares AO algorithms with identical composition, not
XeGTAO's native diffuse-IBL-only material integration against the baseline's
whole-image multiply.
Each copy task owns its relay target (`ownsTargetTexture: true`), so graph
rebuilds synchronize its surface size as well as its source bindings.

The common effect uses a fullscreen triangle at (-1, -1), (3, -1), (-1, 3),
with storage-oriented UV `(x*0.5+0.5, 0.5-y*0.5)`. Vertex/fragment entry points
are `effectFullscreenVertex` / `effectFragment`. Group zero bindings are:

| Binding | Resource                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------- |
| 0       | common scene-color texture                                                                        |
| 1       | XeGTAO visibility relay                                                                           |
| 2       | baseline occlusion relay                                                                          |
| 3       | bilinear sampler from the color facade                                                            |
| 4       | 32-byte uniform: algorithm, split, AO-only, divider, intensity, SSAO-disabled, two padding floats |

Algorithm zero selects XeGTAO; split overrides selection with `uv.x < divider`.
After polarity normalization, apply `1 - clamp((1 - visibility) * intensity * gain, 0, 1)`,
where gain is 1 for XeGTAO and 3 for PR839. Apply the gain before the final
clamp, not by clamping boosted occlusion before multiplying by intensity.
AO-only outputs equal RGB and alpha 1; lit mode multiplies scene RGB and preserves
scene alpha. Draw the divider in RGB (0.25, 0.7, 1) within 0.75 output pixels.
Resize callbacks rebind all three sampled facades before replacing retired views.

Radius and intensity have shared visible controls, with default intensity 0.5.
The baseline's explicit 3x display gain compensates for its fainter effect;
native estimator shaping is unchanged. Show the actual sample settings.
XeGTAO retains its native radius multiplier and quality presets; the baseline
retains its native bias, power, slices and steps. Equal parameter names are not
a claim of equal perceived strength or equal quality.

## Temporal and resolution controls

Default to Half estimation and a 16-observation history bound. The baseline
uses `resolutionScale = 0.5`, `temporalSamples = 16`, and
`temporalWeight = 1/16`; XeGTAO uses its public Half enabler and history bound 16.
Full selects scale 1 in both. Respect XeGTAO's small-viewport Half safeguard and
report when it is inactive.
With Half selected, the reconstruction selector chooses either the original
full-size filter or the new Half pipeline. Its label and status disclose the
quality/performance trade-off; the original default is unchanged.

With temporal filtering off, omit XeGTAO's temporal enabler and velocity MRT.
The baseline sets weight 1: its API still executes resolve/history-copy passes,
which must not be hidden or optimized away in the comparison.

Input, temporal and resolution changes reload the controlled configuration.
The comparison explicitly opts into `enableSsaoMotionPruning` when temporal
filtering is installed. Its checked **Motion pruning (XeGTAO)** control toggles
the extension without resetting history; `pruning=0` preserves the unpruned
comparison. This is a demo configuration, not a change to the core temporal
API's opt-in policy. It avoids full-resolution 36-tap shadow-transport searches
when no moving caster or receiver can affect the pixel. The mask includes
camera-relative XY motion and exact previous-depth-only receiver motion.
Low-sample estimator noise can otherwise increase transport coverage enough to
erase estimation savings or even make Low slower than Ultra. Full-resolution
geometry and temporal reconstruction remain necessary in both Full and Half;
Half's upsample overhead can still limit its benefit at the lowest sample count.
Algorithm selection and preview-mode changes invalidate both histories through
their public reset controls. No history from an inactive algorithm is resumed as
if it had rendered the intervening poses.

## Timing and limitations

Show per-task GPU averages only in A/B mode, where the inactive AO task, input
producer, and relay are disabled. List the selected AO task and its required
producer separately; shared presentation/relay passes are not charged to the
algorithm. Hide timing comparisons in split mode, which runs both algorithms.
Append a `total` line summing the unrounded per-task averages from that same
reporting window, including the input producer, AO, relay and common composite.
This is the sum of listed GPU task durations, not CPU frame time or an AO-only total.
Allow history to settle after a configuration change.
Both implementations remain allocated in this page; A/B isolates GPU execution,
not standalone memory footprint or initialization cost.
Resizing any common presentation target also invalidates both histories and
restarts the 64-frame timing warmup. Baseline slice/step controls reject empty,
fractional, or out-of-range values through native input validity feedback.

GPU timestamps are not clock-normalized. Correlate results with both GPU core
and memory clocks, and use a consistent driver power policy for measurements.
Do not announce a performance winner from an uncontrolled side-by-side run.
This demo contains both algorithms, so its combined bundle size is not a
production bundle-size comparison.

### Local scalability diagnosis

At 1146x1308 in the stationary Contacts preset, paired Low/Ultra runs verified
the actual specialized pipelines (1x2 versus 9x3 samples per side) and dispatch
grids (144x164 Full versus 72x82 Half). Memory clocks stayed at 14001 MHz across
the observations. Controls were not being ignored: unpruned transport instead
cost about 0.43 ms for noisier Low output versus 0.24 ms for Ultra.

With the explicit pruning configuration above, observed complete AO task means
(excluding the input producer and presentation) were:

| Estimation | Quality | Unpruned |   Pruned |
| ---------- | ------- | -------: | -------: |
| Full       | Low     | 0.726 ms | 0.298 ms |
| Full       | Ultra   | 0.800 ms | 0.573 ms |
| Half       | Low     | 0.703 ms | 0.301 ms |
| Half       | Ultra   | 0.585 ms | 0.353 ms |

These are bounded local diagnostics, not CI ceilings or cross-device promises.
They document the pruning decision; later shader optimizations reduced these
costs, and current per-pass timings are in [module 60](60-ssao-half-pipeline.md).
At Low, reconstruction and upsampling dominate: Half does not improve the
complete task despite reducing estimation work. Do not claim a universal 4x
task speedup or weaken temporal correctness to manufacture preset ordering.

### Spatial sampling versus pipeline quality

The quality control is explicitly labelled **XeGTAO spatial sampling**. Its
4/8/18/54 depth taps affect only estimation; resolution, temporal history,
history repair, spatial reconstruction and presentation are independent.
Status includes the selected preset's tap count. Do not silently couple these
settings or make Low artificially worse to exaggerate the control's effect.

A separate bounded observation used the real change handler, matching reset
poses and frames 1/64 at 1146x1308, Half pipeline, intensity 0.5. The table below
is the intensity-scaled grayscale RMS difference from Ultra after 64 frames,
before 8-bit presentation quantization, measured only where either output's
raw visibility is below 0.98:

| Scene                     | Low versus Ultra | High versus Ultra |
| ------------------------- | ---------------: | ----------------: |
| Contacts                  |            3.37% |             0.84% |
| Thin/overlapping layers   |            5.25% |             0.85% |
| Animated skin/morph scene |            3.23% |             0.79% |
| Cornell Box               |            3.94% |             0.89% |

This is a difference measurement, not an accuracy score: Ultra is not a
ground-truth oracle. With Temporal off, High/Ultra differences rose to 1.53%
for Contacts and 1.91% for Layers. Thus the settled High/Ultra similarity is
real; geometric resolution and filtering can dominate the appearance. Retain
the current High default and the optional Ultra preset rather than changing
the estimator or existing reconstruction semantics on this evidence alone.

## Validation

Focused checks cover baseline integrity and path isolation, configuration
validation, scene selection, output polarity and active-pass selection. A bounded
native WebGPU check exercises both algorithms and all scene presets, common
composition, switching, and resize, with uncaptured GPU/page errors treated as
failures. No all-scene, performance-suite, parity-suite, golden or ceiling changes
are required for this comparison demo.

```powershell
pnpm build:bundle-demo ssao-comparison --debug
pnpm test:ao:comparison
```

The numeric GPU contract reads the real compositor output, normalizes each
source's polarity and checks all RGB channels against the corresponding source
texels. It covers AO-only and shared color multiplication, non-unit intensity,
off-center wipes, isolated A/B execution, all optional input combinations,
animated velocity, 901x653 resizing and the small-viewport Half safeguard.
Only the validator enables swapchain `COPY_SRC`; no observation globals, readback
buffers or extra capture passes ship in the demo.

Append `--thumbnail` to explicitly regenerate the representative 1280x720 JPEG.
Ordinary validation never rewrites the gallery asset. Open
`/lite/demo-ssao-comparison.html` in the lab preview; its four presets and input
configuration can also be selected through the URL.

## Lifecycle and file manifest

Creation uses one non-MSAA engine capped at DPR 1 and disables the scene's
default render task. Record tasks in order: ordinary color, optional geometry,
XeGTAO, baseline, current relay, baseline relay, common effect. Geometry requests
RGBA16F velocity first when temporal is enabled, then view normals if requested,
so the optional MRTs plus real color fit the default color-attachment byte limit.
Inactive producers, algorithms and relays use `executionEnabled = false`.

Warm timing history for 64 frames after each reset, collect each new available
GPU timestamp snapshot once, and refresh/reset averages every 250 ms. Asynchronous
timing configuration uses an epoch guard against replaced requests; errors are
reported in the page and console. On `pagehide`, stop the engine, cancel resize
subscriptions, dispose the scene/effect and release the presentation targets.

| File                                               | Responsibility                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `lab/lite/demo-ssao-comparison.html`               | Controls, provenance, explanations and status                       |
| `lab/lite/src/shared/ssao-comparison-contract.ts`  | Configuration, presets, baseline commit/blob hashes, execution plan |
| `lab/lite/src/demos/ssao-comparison.ts`            | Shared targets, tasks, UI, timing and lifecycle                     |
| `lab/lite/src/demos/ssao-comparison-scenes.ts`     | Geometry, cameras, lights and animation helpers                     |
| `lab/lite/src/demos/ssao-comparison-shader.ts`     | Common fullscreen composition                                       |
| `lab/lite/src/demos/ssao-comparison-baseline.d.ts` | Typed subset of the pinned baseline API                             |
| `scripts/ao-reference/comparison-baseline.ts`      | Verified cache and comparison-only Vite plugin                      |
| `scripts/ao-reference/validate-comparison.ts`      | Bounded real-GPU numeric and selection contracts                    |
| `tests/lite/unit/ssao-comparison.test.ts`          | Configuration/integrity/build compatibility contracts               |
| `lab/public/thumbnails/demo-ssao-comparison.jpg`   | Representative demo gallery image                                   |

`demos-config.json` registers the card. `scripts/bundle-demos-core.ts` enables
the baseline plugin only for this slug and copies its shared Cornell assets.
