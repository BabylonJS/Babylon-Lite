# Module: Screen-Space Effects

> Package path: `packages/babylon-lite/src/post-process/screen-space-*`

## Purpose

Provide opt-in screen-space contact shadows and one-bounce screen-space global illumination for WebGPU scenes that already render color and depth into a single-sample offscreen target.

The implementation shares depth reconstruction, dual-surface ray intersection, normal reconstruction, temporal reprojection, depth rejection, and neighborhood clamping. Applications pay no runtime bytes unless they import one of the two public task factories.

The effects are frame-graph tasks. They own every intermediate render target and GPU resource, expose their effect buffer and composited output as managed `RenderTarget` values, and never expose raw WebGPU handles.

## Public API Surface

```ts
export interface ScreenSpaceContactShadowsPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    depthTexture?: RenderTarget;
    camera: Camera;
    lightDirection: Vec3;
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    tint?: readonly [number, number, number];
    stepCount?: number;
    maxDistance?: number;
    thickness?: number;
    bias?: number;
    normalBias?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "multiply";
}

export interface ScreenSpaceContactShadowsPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    readonly shadowTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    tint: readonly [number, number, number];
    stepCount: number;
    maxDistance: number;
    thickness: number;
    bias: number;
    normalBias: number;
    temporalWeight: number;
    resetVersion: number;
    readonly lightDirection: Vec3;
}

export function createScreenSpaceContactShadowsPostProcessTask(
    config: ScreenSpaceContactShadowsPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceContactShadowsPostProcessTask;

export interface ScreenSpaceGlobalIlluminationPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    depthTexture?: RenderTarget;
    camera: Camera;
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    stepCount?: number;
    rayLength?: number;
    thickness?: number;
    bias?: number;
    fadeStart?: number;
    fadeEnd?: number;
    edgeFade?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "additive" | "color-bleed";
    colorBleedGain?: number;
    colorBleedMax?: number;
}

export interface ScreenSpaceGlobalIlluminationPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    readonly illuminationTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    stepCount: number;
    rayLength: number;
    thickness: number;
    bias: number;
    fadeStart: number;
    fadeEnd: number;
    edgeFade: number;
    temporalWeight: number;
    colorBleedGain: number;
    colorBleedMax: number;
    resetVersion: number;
}

export function createScreenSpaceGlobalIlluminationPostProcessTask(
    config: ScreenSpaceGlobalIlluminationPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceGlobalIlluminationPostProcessTask;
```

The mutable fields are sampled immediately before each frame is encoded. Applications can tune or toggle the effects without rebuilding the frame graph. Incrementing `resetVersion` invalidates history and restarts the bounded temporal sample window.

The composite target must differ from `sourceTexture`; sampling and rendering the same texture in one WebGPU pass is invalid. Callers use two render targets when chaining effects.

### Defaults and clamps

| Setting                     | Contact shadows | Global illumination |                        Clamp |
| --------------------------- | --------------: | ------------------: | ---------------------------: |
| `resolutionScale`           |             `1` |               `0.5` |                  `[0.25, 1]` |
| `intensity`                 |           `0.6` |                 `1` |                     `[0, 4]` |
| `stepCount`                 |             `8` |                 `8` |            integer `[1, 64]` |
| `maxDistance` / `rayLength` |           `0.3` |                 `2` |              `[0.001, 1000]` |
| `thickness`                 |          `0.35` |              `0.45` |              `[0.001, 1000]` |
| `bias`                      |          `0.03` |              `0.05` |                   `[0, 100]` |
| `normalBias`                |         `0.035` |                 n/a |               `[0.001, 100]` |
| `temporalWeight`            |        `1 / 32` |            `1 / 64` |                     `[0, 1]` |
| `temporalSamples`           |            `32` |                `64` |           integer `[1, 256]` |
| `fadeStart`                 |             n/a |                `20` |                `[0, 100000]` |
| `fadeEnd`                   |             n/a |                `60` | at least `fadeStart + 0.001` |
| `edgeFade`                  |             n/a |               `0.1` |               `[0.001, 0.5]` |
| `colorBleedGain`            |             n/a |                 `1` |                    `[0, 16]` |
| `colorBleedMax`             |             n/a |              `0.45` |                     `[0, 1]` |

The default contact tint is `[0.35, 0.38, 0.48]`. The default compositions are `"multiply"` for contact shadows and `"additive"` for global illumination.

## Internal Architecture

### Shared shader owner

`screen-space-raymarch-wgsl.ts` owns WGSL functions used by both producers:

- reverse-Z depth load and clear-depth rejection;
- world-position reconstruction from inverse view-projection;
- projection from world position to texture UV;
- closest-neighbor depth normal reconstruction;
- manually bilinear continuous depth;
- dual-surface intersection requiring the ray to be behind both discrete and continuous depth while inside the configured thickness slab;
- decorrelated screen-space hash noise and bounded phase rotation.

The source is a pure string factory. It performs no module-level allocation and has no side effects.

### Shared temporal owner

`screen-space-temporal.ts` creates the two internal passes used after either producer:

1. **Resolve:** reconstruct the current world position, reproject through the previous view-projection, reject off-screen or depth-mismatched history, clamp accepted history to the current 3x3 neighborhood, and blend the current estimate.
2. **History copy:** copy the resolved stable target into the history target used by the next frame.

Scalar history uses `rg16float`: effect value in `.r`, current view distance in `.g`.
Color history uses `rgba16float`: indirect color in `.rgb`, current view distance in `.a`.

The temporal state owns two independent counters:

- **Accumulation count** controls `max(configuredWeight, 1 / accumulatedSamples)`. It resets only after first allocation, target reallocation, disabled-to-enabled transition, singular inverse matrix, or `resetVersion` change. Camera motion does not reset it.
- **Phase window** controls producer ray rotation. Camera motion reopens the window but retains valid reprojected history. Continuous camera motion keeps advancing phases; once motion stops, the window drains for `temporalSamples` frames and then freezes.

The task stores both the previous view-projection and previous view matrices. A current world position is transformed by the previous view matrix to obtain its expected previous view distance and by the previous view-projection to obtain its history UV. History is rejected when:

```text
abs(expectedPreviousViewDistance - storedPreviousViewDistance)
    / max(expectedPreviousViewDistance, 0.001) > 0.04
```

This relative comparison remains meaningful with half-float history at near and far distances.

Camera motion does not discard valid history. World-space reprojection retains matching surfaces. A first frame, target reallocation, singular inverse matrix, disabled-to-enabled transition, or explicit reset uses current-frame weight `1`.

### Reset matrix

| Event                                |  Invalidate history | Restart phase window |
| ------------------------------------ | ------------------: | -------------------: |
| First allocation                     |                 yes |                  yes |
| Owned-target reallocation            |                 yes |                  yes |
| Source/depth texture identity change |                 yes |                  yes |
| Camera movement                      |                  no |                   no |
| `resetVersion` change                |                 yes |                  yes |
| Disabled → enabled                   |                 yes |                  yes |
| Enabled → disabled                   | write identity once |                   no |
| Unrelated frame-graph rebuild        |                  no |                   no |

### Task ownership

Each public task is one frame-graph node whose `record` and `execute` functions orchestrate internal producer, temporal resolve, copy, and optional composite passes. The public graph therefore orders one object while the task retains strict ownership of all targets.

The producer target and temporal targets derive their dimensions from the source render target multiplied by `resolutionScale`, clamped to `[0.25, 1]`. They are rebuilt only when those dimensions change.

Producer and temporal shaders carry separate effect-buffer and source-depth dimensions. Every effect texel is converted to UV before loading the corresponding full-resolution depth texel, so half-resolution GI covers the complete frame rather than the upper-left depth quadrant.

The implementation uses dedicated pipelines rather than `createPostProcessTask`, because it must bind the depth attachment through a depth-only view as `texture_depth_2d`. `depthTexture` means the supplied render target's depth attachment; when omitted, the task reads `sourceTexture`'s depth attachment. Creation fails if that attachment is absent or multisampled.

At execute time, the task compares source color and depth `GPUTexture` identities with those used by its bind groups. A same-sized device-recovery or owner rebuild therefore rebuilds the affected bind groups instead of retaining destroyed texture references.

No general render task, camera, material, or scene module imports these features. Root-index re-exports remain tree-shakable.

## Pipeline Configuration

### Contact shadows

| Pass               | Target            | Format        | Sampling                          |
| ------------------ | ----------------- | ------------- | --------------------------------- |
| Producer           | raw contact       | `r8unorm`     | nearest depth                     |
| Temporal resolve   | stable contact    | `rg16float`   | nearest raw/depth, linear history |
| History copy       | contact history   | `rg16float`   | nearest                           |
| Optional composite | configured target | source format | linear source/contact             |

The producer runs at full resolution by default.

### Global illumination

| Pass               | Target               | Format        | Sampling                          |
| ------------------ | -------------------- | ------------- | --------------------------------- |
| Producer           | raw illumination     | `rgba16float` | nearest depth, linear scene color |
| Temporal resolve   | stable illumination  | `rgba16float` | nearest depth, linear raw/history |
| History copy       | illumination history | `rgba16float` | nearest                           |
| Optional composite | configured target    | source format | linear source/illumination        |

The producer runs at half linear resolution by default.

The global-illumination temporal resolve applies a fused five-tap cross filter to the current raw estimate. Neighbor weights combine a fixed spatial weight with relative view-depth agreement. This removes independent pixel noise without allocating another target or pass.

## Shader Logic

### Contact-shadow producer

1. Load receiver depth. Cleared depth returns zero occlusion.
2. Reconstruct receiver world position and depth-derived world normal.
3. Offset the ray origin along the normal by `bias`.
4. March toward `-lightDirection` for `stepCount` intervals spanning `maxDistance`.
5. Project each ray point and stop outside the screen.
6. Evaluate the shared dual-surface intersection.
7. Reject continuation of the receiver surface with a tangent-plane clearance test.
8. Weight the accepted hit by march distance, penetration confidence, and tangent-plane clearance.
9. Store occlusion in `[0, 1]`.

The multiply composite is:

```wgsl
let amount = shadow * intensity;
result.rgb = source.rgb * mix(vec3f(1), tint, amount);
```

### Global-illumination producer

1. Load receiver depth and reconstruct receiver world position and normal.
2. Generate one cosine-weighted hemisphere direction from pixel noise and temporal phase.
3. March over `rayLength` with the shared dual-surface intersection.
4. On hit, sample the already-lit `sourceTexture` at the hit UV.
5. Apply receiver-distance and screen-border fades.
6. Store indirect color; a miss stores zero.

The additive composite adds `illumination * intensity`.

The optional `color-bleed` composite normalizes illumination by luminance and multiplies source chroma toward that hue:

```wgsl
let luminance = dot(illumination, vec3f(0.2126, 0.7152, 0.0722));
let amount = min(intensity * min(luminance * colorBleedGain, 1), colorBleedMax);
result.rgb = source.rgb * mix(vec3f(1), illumination / max(luminance, 1e-4), amount);
```

`composition: "none"` skips the composite pass and sets `outputTexture` to the stable effect target. This supports application-owned composition without paying for an unused pass. Disabling either effect clears its stable and history targets to zero once; zero means no contact occlusion and no indirect illumination.

### Coordinate convention

The fullscreen UV is storage-oriented with `(0, 0)` at the top-left. Reconstruction and reprojection use:

```wgsl
let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth);
let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
```

No render-target-specific Y flip is applied.

## State Machine / Lifecycle

### Creation

- Validate source/depth sample counts are `1`.
- Clamp numeric settings to safe ranges.
- Allocate only plain task state; GPU targets are deferred to `record`.

### Record

- Resolve source dimensions.
- Allocate or resize owned targets only when their resolved dimensions changed.
- Build pipelines and bind groups against live target views.
- Reset temporal accumulation only when allocation or source/depth texture identity actually changed.

### Execute

- Read mutable settings.
- Compute current inverse view-projection and view matrix.
- Detect camera, source-version, and size changes.
- Upload producer and temporal uniforms.
- Run producer, temporal resolve, history copy, and optional composite.
- Save the current view-projection for the next frame.

When `enabled` is false, the producer is skipped. A configured composite copies the source unchanged; `"none"` clears the stable output to zero on the disable transition. Temporal history is invalidated so re-enabling starts from the current frame.

### Dispose

- Destroy every owned target, uniform buffer, and pipeline reference.
- Never destroy caller-owned source, depth, or target textures.

## Dependencies

- `camera/camera.ts` for view and projection matrices.
- `math/mat4-invert.ts`.
- `engine/render-target.ts`.
- `frame-graph/task.ts`.
- `resource/samplers.ts`.
- `engine/gpu-flags.ts`.

The effects do not depend on the geometry renderer, transmission, depth pyramid, shadows, or materials.

Camera-only reprojection cannot preserve history for independently moving objects. Depth rejection and neighborhood clamping limit trails but do not replace motion vectors. A future optional velocity input can use `GeometryTextureType.LINEAR_VELOCITY` without changing the default dependency-free path.

## Test Specification

### Unit tests

- reverse-Z reconstruction maps known near/far depths correctly;
- dual-surface intersection requires both depth estimates and obeys bias/thickness;
- tangent-plane clearance rejects a smooth self-intersection and accepts separate geometry;
- temporal blend follows the running-mean ramp and configured floor;
- accumulation reset and phase restart follow the reset matrix above;
- reprojection compares history against previous-camera view distance;
- UV → world → UV round-trips with the documented top-left convention;
- public factories clamp invalid resolution, step, and temporal settings;
- generated WGSL contains the scalar/color history layouts and the dual-surface/tangent-plane contracts.

### Demo validation

`demo-screen-space-effects` loads the locally stored Cornell Box GLB from `zuuhr/GlobalIlumination-BabylonJS` into an offscreen color/depth target. Buttons independently toggle contact shadows, global illumination, and auto-orbit. The initial camera looks into the open box; auto-orbit is opt-in so the temporally accumulated effects can converge from a stable view.

The demo must:

- reach `canvas.dataset.ready = "true"`;
- emit no WebGPU validation errors;
- show non-zero contact and illumination buffers;
- remain interactive while toggling each effect and auto-orbit;
- have a generated demo bundle manifest and 1280x720 JPG thumbnail.

### Bundle validation

- A targeted demo build records the feature cost.
- Representative non-feature scene byte counts remain unchanged; scene1 stays exactly 90,780 raw bytes.
- No bundle ceiling is changed.

## File Manifest

```text
packages/babylon-lite/src/post-process/screen-space-raymarch-wgsl.ts
packages/babylon-lite/src/post-process/screen-space-temporal.ts
packages/babylon-lite/src/post-process/screen-space-contact-shadows.ts
packages/babylon-lite/src/post-process/screen-space-global-illumination.ts
packages/babylon-lite/src/index.ts
tests/lite/unit/screen-space-effects.test.ts
lab/lite/src/demos/screen-space-effects.ts
lab/lite/demo-screen-space-effects.html
lab/public/screen-space-effects/cornellBox.glb
lab/public/thumbnails/demo-screen-space-effects.jpg
lab/public/bundle/demos-manifest.json
demos-config.json
scripts/bundle-demos-core.ts
docs/lite/architecture/52-screen-space-effects.md
```
