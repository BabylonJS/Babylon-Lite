# Module: Ocean demo

> Source path: `lab/lite/src/demos/ocean/`
> Entry point: `lab/lite/src/demos/ocean.ts` + `lab/lite/demo-ocean.html`
> Reference: Babylon.js Playground `YX6IB8#758`

`lab/lite/demo-ocean-reference.html` fetches and transpiles that exact Playground revision at
runtime. It replaces the demo's wall clock with a query-controlled clock, so
`?seekTime=4` freezes both spectral time and glTF animation at four seconds unless
`&animate=true` is also supplied. Frozen reference frames also force zero render delta so temporal
foam history does not keep evolving at a fixed wave phase, then stop the render loop before setting
the ready marker. The local reference camera applies a 180-degree yaw after scene creation so both
pages use Lite's buoy-facing comparison view; the reference canvas then mirrors horizontally to
compensate for the source scene's right-handed coordinates versus Lite's left-handed world. Lite
and reference pages link to each other while preserving the query string.

## Purpose

Construction is transactional. Gaussian noise is downloaded and decoded before the large GPU
texture graph is allocated. Texture construction owns each completed allocation immediately;
simulation construction additionally owns its tasks, shaders, binding sets, and storage buffers.
Shader preparation finishes before the simulation is returned. Task disposal releases their
uniform arenas. A failure rolls back all completed allocations in
reverse order and preserves the original error, including cleanup errors when present.

`OceanSimulation.dispose()` is the aggregate teardown operation. Release render consumers and
detach its frame-graph tasks before calling it. Disposed simulations reject further work; pending
initialization cancellation is observed without creating unhandled rejections. Cleanup is idempotent,
and a resource whose external owners prevented disposal remains available for a later cleanup retry.
The demo wires scene disposal to aggregate simulation cleanup after mesh-consumer and deferred
render-task releases. It stops the engine, awaits `waitForGpuResourceRetirements(engine)`, disposes
the simulation, then disposes the engine. An independent `waitForGpuIdle()` fence does not establish
that CPU-side release callbacks have completed. Later demo-initialization failures use this same
path and preserve the original initialization error if cleanup also fails.

Port the Playground FFT ocean to Babylon Lite as a modular showcase of frame-graph compute.
The final demo reproduces the reference's spectral wave generation, three frequency cascades,
inverse FFT, displaced clipmap geometry, ocean shading, procedural sky, buoyancy, buoy mesh,
shadows, glow, debug views, and editable parameters.

The Lite page uses the reference FreeCamera pose and matching environment/direct-light defaults.
The ocean is a PBR material with an opt-in material plugin, mirroring the reference's
`PBRCustomMaterial`: the plugin owns displacement, derivative normals, turbulence/contact foam,
distance roughness, SSS color, and water emissive composition, while the shared PBR pipeline owns
direct lights, point-light falloff, shadows, irradiance, specular IBL, the BRDF LUT, tone mapping,
and gamma output. The previous standalone approximation shader is not retained.

The camera-centered procedural sky follows Babylon.js `SkyMaterial`'s atmospheric model: Rayleigh
and Mie scattering, optical extinction, Henyey-Greenstein phase, sun disk, and Uncharted 2 tone
mapping. Sky controls use the same defaults and inclination/azimuth-to-sun-position convention as
the reference. The same scattering function populates a 128×128 six-face `rgba16float` environment
cubemap. Every update regenerates its ordinary mip chain and recomputes irradiance harmonics from
the atmospheric radiance, matching the reference reflection probe instead of sampling an unrelated
static environment.
The environment loader owns the BRDF LUT and procedural cube directly rather than downloading and
retaining an unused `.env` cube. Runtime irradiance integration yields in deterministic chunks and
publishes only the latest completed control update. The directional light diffuse color is derived
from the same atmospheric state.

The procedural probe compute shader writes standard WebGPU cubemap layers in
`+X, -X, +Y, -Y, +Z, -Z` order. It preserves the panorama projection's established per-face
orientation but permutes its source-face indices into that standard layer order; replacing the
projection itself changes the probe colors. The sampled direction also includes the
reflection-probe Y compensation used by the Ocean PBR path. Leaving the rotated source order
unpermuted places a horizon sun in the wrong cube face; overhead lighting hides that error because
it is horizontally symmetric.

At zero environment and directional-light intensity, the water keeps the reference's dark-blue
body emissive term, while foam is black because it is lighting-dependent and distance haze
converges to deep water rather than the bright sky horizon. The buoy has no ambient hemispheric
light. Its yellow point light uses the reference's parent-relative position, linear diffuse color,
physical falloff, and intensity. The point light also contributes inverse-square diffuse and
specular lighting to the custom ocean material, so the water around the buoy receives the same
localized warm light instead of evaluating only the environment and directional sun.

The implementation is split by responsibility. No source file owns the entire demo, and WGSL is
kept in dedicated shader modules rather than embedded in the orchestration entry point.

## Scope and staged delivery

### Stage 1: spectral compute foundation (implemented)

- One initial JONSWAP cascade with the reference's default local and swell spectra.
- GPU initial-spectrum generation.
- GPU time-dependent complex amplitudes.
- Precomputed FFT twiddle factors.
- Horizontal and vertical inverse FFT stages.
- Final displacement and derivative textures.
- A displaced grid rendered with a dedicated ocean shader.

This stage established the visible, continuously animated numerical foundation before the later
stages expanded it.

### Stage 2: complete reference wave system (implemented)

- Default resolution is `256 x 256`.
- Reference length scales are `250`, `17`, and `5`.
- Apply frequency cutoffs between cascades.
- Add ping-pong turbulence accumulation and generated derivative/turbulence mip chains.
- Add runtime spectrum controls without reallocating the simulation graph.

### Stage 3: rendering and world parity (implemented)

- Camera-relative concentric clipmap geometry with center, rings, trims, and skirt.
- Three material LODs sampling the appropriate cascade subset.
- Reference water color, Fresnel, roughness, subsurface scattering, foam, and contact foam.
- Scene depth input, directional light, shadows, procedural sky/reflection approximation, bloom,
  and final-frame SMAA.

### Stage 4: authored content and controls (implemented)

- Babylon buoy glTF, point light, bloom glow, and GPU displacement-probe buoyancy sampling.
- DOM control panel replacing the reference's runtime-loaded dat.GUI dependency.
- The same General, Sky, Waves Generator, Ocean Geometry, Ocean Shader, and Buoyancy settings as
  the reference, excluding its Glow Layer toggle because Lite uses bloom rather than a glow layer.
- The shadow control uses `setShadowGeneratorEnabled()` so the attached receiver bindings remain
  stable while disabled maps stop rendering.
- Resolution changes persist through query parameters and rebuild the page because compute texture
  dimensions are immutable. Length scale, vertex density, clip levels, skirt size, wireframe, and
  material LOD rebuild only the clipmap meshes in-place; the explicit Ocean render task opts into
  `enableRenderTaskMeshRefresh()` so those runtime mesh/material rebuilds refresh its bindings. All
  other controls update live.
- Ring and trim clone families remain GPU-shared after vertex-density or wireframe rebuilds:
  `resizeSharedMeshGeometry()` uploads each family once and reassigns the replacement allocation to
  every clone with reference-counted ownership.
- The fixed 256×256 EXR noise asset is decoded using the reference implementation's linear source
  prefix for lower selectable resolutions. This preserves reference output even though the prefix
  spans complete 256-wide source rows rather than forming a square crop.
- The opaque sampled depth target is surface-sized and updates its stable texture facade during
  frame-graph resize rebuilds, so contact foam follows canvas and device-pixel-ratio changes.
- Optional compute texture debugger.
- Deterministic `seekTime` support for diagnostics (`seektime` is accepted as a lowercase alias).
  The reference page keeps rendering while
  paused and toggles its simulation clock plus animation groups with `P`, so controls remain
  usable on a frozen comparison frame. A seek replays the reference simulation from zero at a
  fixed 60 Hz before pausing because turbulence/foam is a stateful ping-pong texture that integrates
  frame delta; jumping only the absolute spectrum time leaves that texture at zero and saturates the
  ocean foam white. Warmup calls the three cascades' compute updates directly rather than rendering
  the scene, so it does not reuse browser swapchain textures. After the final compute step it
  performs one awaited displacement readback and deterministically settles the buoyancy state.
  Seeks through 12 seconds replay exact 60 Hz history. Longer seeks use at most 720 evenly spaced
  steps (or more only when required to keep each delta at or below the reference's 0.5-second cap),
  preventing long URLs such as `seekTime=50` from queuing thousands of full FFT frames. The
  reference displays progress while this warmup runs.
  Lite and the reference perform the same replay even when `animate=true`; animation resumes only
  after the deterministic state and buoy pose have been established. The Lite ready marker is set
  only after that settled pose has rendered. Pausing disables further buoyancy readbacks after that
  solve; resuming enables them again.
  Lite performs the same replay with `submitComputeTasks()` over its spectrum, FFT, and merge tasks,
  with buoy probe coordinates initialized before the first merge. The last warmup merge therefore
  leaves a valid buoy sample buffer for the post-start readback. The final pose solver repeats
  `numSteps * 2 + 2` probe-only submissions, transforming the three probe points by each newly
  updated buoy pose and using the reference's unshifted bilinear texel coordinates. Each probe
  samples its original point once, matching the reference implementation (whose apparent four-step
  displacement correction resamples the original position each time). Lite then regenerates final
  derivative/turbulence mipmaps on the first rendered frame.

The exact attenuated quaternion solver above is used only while settling a sought frame. Live Lite
animation keeps the latest asynchronous GPU samples but interpolates position and Euler tilt every
render frame, preventing visible six-frame steps between buoy readbacks.

Free-camera vertical movement uses Space/PageUp for up and C/PageDown for down. The mirrored
reference canvas reverses visible horizontal movement, so its keyboard input maps D/Right Arrow to
internal left and A/Q/Left Arrow to internal right. The wrapper replaces the reference
`_setCameraKeys()` method itself so toggling its ZQSD checkbox preserves these mappings. Its
horizontal pointer delta is reversed after Babylon.js applies it, compensating for the CSS canvas
mirror without changing vertical mouse look.

In the Lite demo, F8 toggles the badge, GPU timing panel, and parameter controls. The browser-console
function `getOceanCameraParameters()` returns copyable position, Euler rotation, and target values for
the live camera.

## Module boundaries

```text
ocean.ts                         page entry and loading/error lifecycle
ocean/buoy.ts                    buoy asset, light, and displacement-driven buoyancy
ocean/controls.ts                DOM controls and debug selector
ocean/debug.ts                   orthographic live compute-texture overlay
ocean/demo.ts                    engine, scene, camera, task ordering
ocean/lifecycle.ts               fenced retirement drain and simulation/engine teardown
ocean/constants.ts               fixed defaults and workgroup dimensions
ocean/spectrum.ts                JONSWAP CPU parameter packing
ocean/resources.ts               owned compute texture allocation
ocean/fft.ts                     twiddle and ordered inverse-FFT dispatch construction
ocean/simulation.ts              initial and per-frame compute task assembly
ocean/geometry.ts                center/ring/trim/skirt clipmap mesh generation
ocean/material.ts                three PBR LOD variants and live plugin-state updates
ocean/material-plugin.ts         reference PBRCustomMaterial displacement/shading injections
ocean/shaders.ts                 compute WGSL
ocean/sky.ts                     camera-centered procedural sky
ocean/timing.ts                  opt-in task GPU timings and smoothed FPS panel
```

No module-level registries or eagerly allocated maps are permitted.

## Compute resources

Each cascade allocates:

| Resource                  | Format        | Access            | Purpose                                   |
| ------------------------- | ------------- | ----------------- | ----------------------------------------- |
| `h0k`                     | `rg32float`   | storage + sampled | Gaussian initial complex amplitude        |
| `h0`                      | `rgba32float` | storage + sampled | `h0(k)` and conjugated `h0(-k)`           |
| `wavesData`               | `rgba32float` | storage + sampled | wave vector, inverse magnitude, frequency |
| four amplitude textures   | `rg32float`   | storage + sampled | complex displacement/derivative spectra   |
| four FFT scratch textures | `rg32float`   | storage + sampled | final spatial-domain fields               |
| `displacement`            | `rgba16float` | storage + sampled | XYZ displacement                          |
| `derivatives`             | `rgba16float` | storage + sampled | surface slopes and horizontal derivatives |
| two turbulence textures   | `rgba16float` | storage + sampled | ping-pong foam history                    |

Displacement uses bilinear filtering without mipmaps. Derivative and turbulence outputs use
trilinear mip filtering, repeat addressing, and `maxAnisotropy = 4`, matching the reference
`RawTexture` defaults and preserving high-frequency detail at grazing view angles.

The three cascades share one `rgba32float` twiddle texture. Resources have stable identity.
Immutable binding sets are created for every ping-pong direction;
dispatch execution never swaps resource handles or rebuilds bind groups.

Initial spectrum Gaussian values come from the same fixed
`https://assets.babylonjs.com/environments/noise.exr` R/G channels as the reference. Lite extracts
the asset with the reference's byte layout and uploads it as a read-only `vec2<f32>` storage
buffer. Do not replace it with `Math.random()` or a procedural hash: either produces a different
ocean realization, so equal `seekTime` values no longer identify the same displacement field.

## Task ordering

The scene frame graph contains:

1. `ocean-initialize`, configured as a one-shot task:
    - generate initial spectrum and wave metadata;
    - generate the conjugated spectrum;
    - precompute FFT twiddle factors.
2. `ocean-spectrum`, executed every active frame, updates time-dependent spectra.
3. `ocean-fft` executes horizontal and vertical FFT stages for four complex fields per cascade and
   permutes/sign-corrects each result.
4. `ocean-merge` writes displacement, derivative, and turbulence textures and samples three
   first-cascade points into a 48-byte buoyancy buffer.
5. An opaque depth prepass provides contact-foam depth.
6. The scene render task draws the procedural sky, buoy, and ocean.
7. Bloom and SMAA produce the final swapchain image.

One task maps to one WebGPU compute pass. Initialization and simulation are separate tasks so the
one-shot can disable itself after the first successful submission while preserving the ordering
boundary before recurring simulation.

## Uniform layout

The initialization task owns:

```ts
struct SpectrumParams {
    size: u32,
    lengthScale: f32,
    cutoffHigh: f32,
    cutoffLow: f32,
    gravity: f32,
    depth: f32,
}
```

Two `SpectrumParameter` records are stored in one read-only storage buffer:

```ts
struct SpectrumParameter {
    scale: f32,
    angle: f32,
    spreadBlend: f32,
    swell: f32,
    alpha: f32,
    peakOmega: f32,
    gamma: f32,
    shortWavesFade: f32,
}
```

The simulation task owns:

- one time uniform slot;
- one merge uniform slot;
- one dynamic FFT uniform slot per FFT stage.

All slots use typed allocation-free writers. FFT dispatches retain dynamic offsets into one arena;
the arena performs one enclosing upload before the compute pass.

## Spectrum math

The implementation preserves the reference formulas:

```text
omega(k)       = sqrt(g * k * tanh(min(k * depth, 20)))
alpha          = 0.076 * (g * fetch / windSpeed²)^-0.22
peakOmega      = 22 * (windSpeed * fetch / g²)^-0.33
JONSWAP        = scale * TMA * alpha * g² * omega^-5
                 * exp(-1.25 * (peakOmega / omega)^4)
                 * gamma^r
directionality = mix(cos² distribution, cosine-2s distribution, spreadBlend)
```

The reference optionally loads Gaussian values from `noise.exr` and otherwise generates normal
random values on the CPU. The port generates deterministic Box-Muller Gaussian values in the
initial-spectrum compute shader. This changes only the random realization, not the spectrum model.

## FFT

For a power-of-two texture size `N`, twiddle precomputation writes a
`log2(N) x N` `rgba32float` texture. Each row contains:

```text
(twiddle.real, twiddle.imaginary, inputIndex0, inputIndex1)
```

Each complex field executes `log2(N)` horizontal and `log2(N)` vertical stages. Immutable A/B and
B/A binding sets select the ping-pong direction. A final checkerboard sign permutation writes the
spatial result into the field's dedicated output texture.

The dispatch counts are derived from explicit exported workgroup constants. Runtime code never
parses WGSL source to discover workgroup dimensions.

## Rendering

The final renderer uses a camera-relative concentric clipmap:

- center, ring, trim, and skirt meshes snap around the camera using the reference geometry rules;
- vertex shader blends the three displacement cascades by view distance;
- the PBR material plugin blends derivatives and turbulence, reconstructs the normal, and adds
  contact foam from an opaque depth prepass sized to the active canvas. The fragment samples depth
  from its framebuffer pixel coordinate divided by the live canvas size and computes
  `backgroundViewDepth - waterViewDepth`. Reversing that subtraction treats the submerged buoy
  behind the water as contact and turns its projected silhouette into a white foam streak;
- the material uses public PBR material-plugin and `Texture2D` APIs.

The renderer never accesses a raw `GPUTexture`, `GPUTextureView`, sampler, device, or command
encoder.

## Lifecycle

- The demo creates all resources once.
- Initialization runs once after successful frame submission.
- Simulation mutates only retained uniform bytes and dispatch enabled state.
- Resize does not recreate simulation textures.
- Compute device-loss reconstruction is not implemented; the wider device-loss subsystem is being
  redesigned separately.

## Hot-path requirements

- No arrays, maps, binding sets, shaders, pipelines, textures, or closures are created per frame.
- Time updates write one scalar into retained uniform storage.
- FFT stage offsets and binding sets are fixed at construction.
- Dispatch dimensions are precomputed.
- Render texture bindings remain stable.
- Buoyancy reads only three `vec4<f32>` samples through a reusable staging buffer and throttles
  requests to one every six rendered frames. The live before-render callback defers the read by
  one microtask so the synchronous frame submission precedes the independent staging copy;
  direct `readStorageBuffer` calls during recording are rejected. Seek-time probe submissions
  already run outside frame recording and remain explicitly ordered before their reads.
- The GPU timing panel opts into per-task timestamp queries after scene registration. It reports
  separate spectrum-evolution, inverse-FFT, and merge/probe compute passes, their combined compute
  cost, compute-output mip tasks, total timed task cost, and an exponentially smoothed FPS value
  without stalling the GPU. One-shot initialization is excluded because the panel displays
  recurring latest-frame timing rather than retaining historical task samples.

## Test specification

- Unit tests cover spectrum parameter packing, grid topology, FFT stage ordering, ping-pong
  selection, and power-of-two validation.
- The demo build must succeed as a single filtered demo bundle.
- A browser smoke test observes paused and animated seeks reaching
  `canvas.dataset.ready === "true"`, exercises resume, and rejects WebGPU validation errors.
- Visual reference work begins only after the three-cascade renderer is complete.

## File manifest

- `docs/lite/architecture/demo-ocean.md`
- `lab/lite/demo-ocean.html`
- `lab/lite/demo-ocean-reference.html`
- `lab/lite/src/demos/ocean.ts`
- `lab/lite/src/demos/ocean/buoy.ts`
- `lab/lite/src/demos/ocean/constants.ts`
- `lab/lite/src/demos/ocean/controls.ts`
- `lab/lite/src/demos/ocean/demo.ts`
- `lab/lite/src/demos/ocean/lifecycle.ts`
- `lab/lite/src/demos/ocean/fft.ts`
- `lab/lite/src/demos/ocean/geometry.ts`
- `lab/lite/src/demos/ocean/material.ts`
- `lab/lite/src/demos/ocean/resources.ts`
- `lab/lite/src/demos/ocean/shaders.ts`
- `lab/lite/src/demos/ocean/simulation.ts`
- `lab/lite/src/demos/ocean/sky.ts`
- `lab/lite/src/demos/ocean/spectrum.ts`
