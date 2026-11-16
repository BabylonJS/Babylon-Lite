# Module: Compat SSAO2 Scene Pipeline

> Package paths: `packages/babylon-lite/src/post-process/scene-ssao.ts`, `packages/babylon-lite/src/post-process/screen-space-ambient-occlusion.ts`, `packages/babylon-lite/src/frame-graph/post-process-task.ts`

## Purpose

Provide an opt-in native scene-output pipeline that the Babylon.js compatibility package can expose as `SSAO2RenderingPipeline`. The native module owns rendering, render-target allocation, graph ordering, resize behavior, MSAA resolve behavior, and cleanup. The compat package only translates Babylon.js names, defaults, and camera-manager calls.

The pipeline intentionally adapts Babylon Lite's existing temporal horizon-based ambient occlusion. It does not claim estimator-level pixel equivalence with Babylon.js SSAO2. The supported output path is one fullscreen active camera and one attached SSAO pipeline per scene.

## Public API Surface

```ts
export interface SceneSsaoPipelineOptions {
    name?: string;
    resolutionScale?: number;
    radius?: number;
    intensity?: number;
    base?: number;
    fadeEnd?: number;
    targetTexture?: RenderTarget;
    resolveTexture?: RenderTarget;
}

export interface SceneSsaoPipeline {
    readonly name: string;
    camera: Camera;
    resolutionScale: number;
    radius: number;
    intensity: number;
    base: number;
    fadeEnd: number;
    readonly attached: boolean;
}

export function createSceneSsaoPipeline(options: SceneSsaoPipelineOptions, engine: EngineContext, scene: SceneContext, camera: Camera): SceneSsaoPipeline;
export function attachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera?: Camera): void;
export function detachSceneSsaoPipeline(pipeline: SceneSsaoPipeline, camera?: Camera): void;
export function disposeSceneSsaoPipeline(pipeline: SceneSsaoPipeline): void;
```

`createSceneSsaoPipeline` creates initially detached pure state. The standalone attach function allocates and registers fresh tasks. The detach function removes and disposes every owned task and target. The dispose function is idempotent and permanently prevents reattachment. Scene ownership and task resources live in a lazily-created module-private weak map, not on the public state object.

`ScreenSpaceAmbientOcclusionPostProcessTaskConfig` and `ScreenSpaceAmbientOcclusionPostProcessTask` gain mutable `base` composition strength and optional mutable `resolveTexture`. `PostProcessTaskSettings` and `PostProcessTask` gain optional mutable `resolveTexture`.

## Internal Architecture

The controller locates the scene's default render task by finding the render task whose color target or resolve target is the scene surface swapchain target. When PBR transmission has already retargeted the scene, it instead selects the render task preceding `transmission-image-processing`. The controller temporarily retargets that existing task and restores its exact color/resolve targets on detach or rollback.

### No MSAA

1. `scene-source`: single-sample surface-relative color target `C`.
2. The existing scene render task renders into `C` while retaining its existing depth attachment.
3. Native SSAO reads color from `C`, reads the existing scene depth, and composites directly into `scRT`.

### MSAA

1. The existing scene render task retains its surface-relative MSAA color/depth target `M1`.
2. `scene-source`: surface-relative single-sample color target `C`.
3. The existing scene render task resolves color from `M1` into `C`.
4. `scene-depth`: surface-relative single-sample depth target `D`.
5. Existing depth-resolve task copies sample zero from `M1` depth into `D`.
6. `scene-output-msaa`: surface-relative MSAA color target `M2`.
7. Native SSAO reads `C` and `D`, composites into `M2`, and resolves `M2` into `scRT`.

The default render task retains ownership of `M1`. The controller owns `C`, `D`, and `M2`. On detach, the controller restores `M1` to its owner and never disposes it. During scene teardown, after the frame graph has disposed the retargeted task, the scene-lifetime cleanup disposes the displaced task-owned `M1`; eager shared targets such as `scRT` remain externally owned.

When native PBR transmission is enabled, transmission brackets its scene-output mutation with the optional `_outputPipelineChange` seam. SSAO restores the render task before transmission retargets it, then rebuilds its chain around the resulting linear HDR target. Its composite writes a single-sample HDR output exposed through `scene._outputTexture`; the trailing transmission image-processing task resolves that getter and remains the final swapchain writer. On a registered scene, changing or restoring `_outputTexture` immediately re-records that trailing task so its bind group never retains the prior target. This supports either attachment order at 1x and 4x MSAA, including live attach and detach.

Tasks are inserted immediately after the default task in producer order. When the scene is already registered, each inserted task is built individually with `buildFrameGraphTask`; existing tasks are not rebuilt. Surface-relative descriptors preserve target identity across resize while their GPU allocations are rebuilt by existing render-target logic.

## Pipeline Configuration

`PostProcessTask.resolveTexture` is valid only when `outputTexture` is multisampled and `resolveTexture` is single-sample. It must not alias the primary or extra sampled inputs; this is checked before the resolve destination is rebuilt. Formats and physical dimensions must match. The render pass binds `outputTexture._colorView` as `view` and the current `resolveTexture._colorView` as `resolveTarget`. Swapchain views are reread during every execution.

### Explicit overlay output (breaking change)

The native controller accepts optional caller-owned `targetTexture` and `resolveTexture` destinations. A resolve requires a target; the target must differ from a multisampled scene producer because rebuilding an aliased target would invalidate its depth/resolve consumers. Supplied targets are built by the composite but never disposed by pipeline detach. Defaults retain the standalone SSAO presentation path.

To add gizmos, allocate the final MSAA color target, pass it as `targetTexture`, and pass the same target as `rt` to `createUtilityLayer` or `createOverlayScene`. Supply the screen as the corresponding resolve destination. Later composites must continue that explicit color chain. No task output accessor or active-resolver search is used. If a chain changes targets or sample count, recreate/rewire its overlay consumers explicitly.

Compat `UtilityLayerRenderer(scene, targets)` and `GizmoManager(scene, targets)` also require explicit native `{ rt, rst? }` destinations (breaking change). They never infer a target from the scene or a pipeline. The compat SSAO constructor accepts the same destinations as its optional seventh argument, a Lite-specific extension. Target references are not serialized; callers must supply them again when recreating the pipeline. Automatic utility-layer retargeting on SSAO attach/detach is not supported; recreate layers when the output chain changes. Babylon.js compatibility is best-effort, not a reason to add task scans or swapchain copies.

```ts
const rt = engine.msaaSamples > 1 ? createRenderTarget({ format: engine.format, samples: engine.msaaSamples, size: engine }) : engine.scRT;
const targets = { rt, rst: engine.msaaSamples > 1 ? engine.scRT : undefined };
const ao = createSceneSsaoPipeline({ targetTexture: rt, resolveTexture: targets.rst }, engine, scene, camera);
attachSceneSsaoPipeline(ao);
const utility = createUtilityLayer(scene, targets);
// Add gizmos, register the scene and utility layer normally.
// Detaching AO requires rewiring/recreating the utility layer against its new producer.
```

## Shader Logic

The existing SSAO estimator, denoiser, and temporal reconstruction are unchanged. Only multiply composition gains a `base` term:

```wgsl
amount = clamp(occlusion * intensity - base, 0.0, 1.0);
output = vec4(color.rgb * (1.0 - amount), color.a);
```

`base = 0` exactly preserves existing output. `base` is sampled by the composite uniform each frame and does not invalidate temporal history.

## State Machine / Lifecycle

- **Detached:** the default task retains its original color/resolve targets; no owned tasks or targets exist.
- **Attached + camera active:** the retargeted default render, optional depth resolve, and enabled SSAO composite execute.
- **Attached + camera inactive:** the render and SSAO identity composite still execute so the other camera's color output is preserved, while the unused depth-resolve task is disabled.
- **Detach:** remove owned tasks, dispose them in reverse consumer order, dispose controller-owned targets, restore the default task targets, and clear references.
- **Reattach:** allocate a completely fresh task chain and temporal history.
- **Failure:** rollback performs the same cleanup as detach and restores the captured default targets before rethrowing.
- **Dispose:** detach, mark disposed, and make later attach calls fail.

Only one native scene SSAO controller may be attached to a scene at a time. A second attachment throws before mutating graph state.

## Babylon.js Equivalence Map

| Babylon.js surface              | Native mapping                                 |
| ------------------------------- | ---------------------------------------------- |
| `SSAO2RenderingPipeline.radius` | `SceneSsaoPipeline.radius`                     |
| `totalStrength`                 | `intensity`                                    |
| `base`                          | composition `base`                             |
| `maxZ`                          | `fadeEnd`; fade starts at 75% of this value    |
| `ratio.ssaoRatio`               | `resolutionScale`                              |
| manager attach/detach           | `attach` / `detach`                            |
| `dispose()`                     | native controller disposal and manager removal |

Estimator-specific Babylon.js controls without a native semantic (`samples`, `epsilon`, `minZAspect`, `expensiveBlur`, and independent blur ratio) are retained by the compat wrapper for readback and warn once when assigned a non-default value. They do not alter native rendering.

## Dependencies

- Existing render task, depth-resolve task, render targets, frame-graph insertion/removal, and native screen-space ambient occlusion.
- No module imports this feature except the compat wrapper. The root barrel re-export is tree-shaken for all non-compat consumers.
- The general case where a later single-sample custom composite writes `scRT` after the active MSAA resolver remains outside this module: resolving the overlay's MSAA attachment afterward would overwrite that later writer. Callers must wire overlays to the final target; there is no implicit compatibility fallback.

## Test Specification

- Post-process resolve validation: sampled-input alias rejection before allocation, sample count, format, dimensions, and live swapchain resolve view.
- SSAO composition: `base` appears in the uniform contract; explicit caller-owned color/resolve targets survive detach.
- Overlay selection: last active MSAA resolver wins; disabled/execution-disabled/single-sample tasks are ignored.
- Scene pipeline: no-MSAA and MSAA task topology, producer order, default-target capture/restore, camera gate changes, transmission composition in both attachment orders, registered-scene incremental build, rollback, detach/reattach fresh resources, and idempotent disposal.
- Compat: stable lazy manager identity, transactional constructor registration, add/attach/detach/dispose forwarding, Babylon.js defaults and property mappings, warning-once unsupported settings, and inert headless construction.

## File Manifest

- `packages/babylon-lite/src/post-process/scene-ssao.ts` — native pure state plus standalone lifecycle functions.
- `packages/babylon-lite/src/post-process/screen-space-ambient-occlusion.ts` — `base` and resolve forwarding.
- `packages/babylon-lite/src/frame-graph/post-process-task.ts` — generic MSAA output resolve support and output descriptor.
- `packages/babylon-lite/src/frame-graph/task.ts` — internal task output descriptor type.
- `packages/babylon-lite/src/scene/overlay-scene.ts` — explicit borrowed color/resolve targets and independent depth.
- `packages/babylon-lite-compat/src/post-processes/post-process-render-pipeline-manager.ts` — Babylon-shaped registry and camera forwarding.
- `packages/babylon-lite-compat/src/post-processes/ssao2-rendering-pipeline.ts` — Babylon-shaped SSAO2 adapter.
