# Module: WebXR (WebGPU binding)

> Package path: `packages/babylon-lite/src/xr/`

> **Status: Forward-looking / not yet runnable in any browser.**
> This module targets the **draft** [WebXR/WebGPU binding](https://github.com/immersive-web/WebXR-WebGPU-Binding)
> (`XRGPUBinding`, projection layers, `getViewSubImage`). No user agent ships the
> binding today, so the code is structured, typed, and unit-tested against mocks,
> ready to run the moment a UA implements it. The authoritative API is the
> exported TSDoc in `packages/babylon-lite/src/xr/`.

---

## Purpose

Render a Babylon Lite scene stereoscopically to an immersive XR device
(`immersive-vr` or `immersive-ar`) through the WebGPU XR binding, and surface
basic input sources (controller target-ray / grip poses + select/squeeze
events).

The module is **100% opt-in and tree-shakable**. A scene that imports nothing
from `xr/` pays **zero bytes** — critically, the integration adds **no code to
`camera.ts`, `render-task.ts`, or any hot-path/shared chunk**. It reuses the
existing engine machinery (frame graph, render tasks, eager render targets, the
camera matrix caches) rather than threading XR-specific branches through it.

Out of scope for this pass: teleport, hand-joint tracking, haptics, AR hit-test,
anchors, and any default-experience UI.

---

## Public API Surface

All exported from the package barrel `packages/babylon-lite/src/index.ts`.

### `xr/xr-support.ts`
```ts
type XrSessionMode = "immersive-vr" | "immersive-ar";

function isWebXrPresent(): boolean;                              // navigator.xr exists
function isWebGpuXrSupported(): boolean;                         // global XRGPUBinding exists (false everywhere today)
function isXrSessionSupported(mode: XrSessionMode): Promise<boolean>; // combines both + navigator.xr.isSessionSupported; never throws
```

### `xr/xr-camera.ts`
```ts
interface XrCamera extends Camera {
    readonly eye: XREye;          // "left" | "right" | "none"
    _world: Mat4Storage;          // @internal mutable eye pose (view→world), backs worldMatrix
    _wmv: number;                 // @internal version, backs worldMatrixVersion
}

function createXrCamera(eye: XREye): XrCamera;
function updateXrCameraForView(
    cam: XrCamera, view: XRView, rtWidth: number, rtHeight: number, viewport: NormalizedViewport,
): void;
```

### `xr/xr-input.ts`
```ts
interface XrInputSource {
    readonly source: XRInputSource;       // underlying WebXR source
    readonly handedness: XRHandedness;
    readonly targetRayMode: XRTargetRayMode;
    readonly targetRayMatrix: Float32Array;  // column-major 4×4, valid when targetRayTracked
    targetRayTracked: boolean;
    readonly gripMatrix: Float32Array;       // valid when gripTracked
    gripTracked: boolean;
    selecting: boolean;                      // true between selectstart/selectend
    squeezing: boolean;                      // true between squeezestart/squeezeend
    readonly gamepad: Gamepad | null;
}

interface XrInputCallbacks {
    onInputSourcesChange?(added: readonly XrInputSource[], removed: readonly XrInputSource[]): void;
    onSelectStart?(i: XrInputSource): void;  onSelect?(i): void;  onSelectEnd?(i): void;
    onSqueezeStart?(i: XrInputSource): void; onSqueeze?(i): void; onSqueezeEnd?(i): void;
}

interface XrInputManager { readonly inputSources: readonly XrInputSource[]; /* + @internal state */ }

function createXrInputManager(session: XRSession, callbacks: XrInputCallbacks): XrInputManager;
function updateXrInputPoses(mgr: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): void;
function disposeXrInputManager(mgr: XrInputManager): void;
```

### `xr/xr-session.ts`
```ts
interface XrSessionOptions {
    mode?: XrSessionMode;                                   // default "immersive-vr"
    referenceSpaceType?: XRReferenceSpaceType;              // default "local-floor", falls back to "local"
    requiredFeatures?: string[];                            // merged with mandatory "webgpu"
    optionalFeatures?: string[];
    colorFormat?: GPUTextureFormat;                         // default binding.getPreferredColorFormat()
    depthStencilFormat?: GPUTextureFormat | null;           // default "depth24plus"; null = color-only
    input?: XrInputCallbacks | false;                       // false disables input tracking
    onFrame?(ctx: XrSessionContext, frame: XRFrame, time: DOMHighResTimeStamp): void;
    onEnd?(): void;
}

interface XrSessionContext {
    readonly mode; session; binding; layer; referenceSpace; scene; engine;
    readonly colorFormat; depthFormat;
    readonly cameras: readonly XrCamera[];                  // per-eye, in XRViewerPose.views order
    readonly input: XrInputManager | null;
    /* + @internal lifecycle state */
}

function enterXr(scene: SceneContext, options?: XrSessionOptions): Promise<XrSessionContext>;
function exitXr(ctx: XrSessionContext): Promise<void>;
```

### Ambient draft types — `xr/webxr-webgpu.d.ts`
Global script (no import/export) so its `interface` blocks merge with the lib
globals. Declares `XRGPUBinding`, `XRGPUSubImage`, the layer-init dictionaries,
`GPURequestAdapterOptions.xrCompatible`, and `XRRenderState(Init).layers`. Starts
with `/// <reference types="webxr" />` so the standard WebXR DOM types
(`@types/webxr`) are pulled in regardless of the `tsconfig.base.json` `types`
allowlist (`["@webgpu/types"]`).

---

## Internal Architecture

### Per-eye render unit
The session owns one `XrEyeUnit` per `XRView` (one per eye), each holding:
- an **eager** `RenderTarget` (`_eager = true`),
- an `XrCamera`,
- a scene-mirroring `RenderTask` (`createRenderTask({ rt, clr, cam }, engine, scene)`).

**One render task per eye** (not one shared task retargeted twice) because each
render task owns its own `_sceneUBO`. A single shared UBO would alias across eyes:
`queue.writeBuffer` only leaves the *last* written value visible before submit, so
both eyes would read the second eye's view/projection.

### Zero-cost camera matrix injection (`xr-camera.ts`)
Instead of adding an XR override branch to the shared `camera.ts` getters (which
would grow every scene's bundle), `XrCamera` writes directly into the matrix
caches those getters already read:

- **View matrix + eye position** derive for free from `worldMatrix`. Setting
  `_world = XRView.transform.matrix` (the eye pose, view→world, column-major) and
  bumping `_wmv` makes `getViewMatrix` produce the inverse rigid transform and
  `_packSceneUniforms` read the eye position from the world translation column —
  both automatically.
- **Projection** is the per-eye *asymmetric* frustum from `XRView.projectionMatrix`,
  which the symmetric-perspective `getProjectionMatrix` cannot reproduce. It is
  injected straight into `_projCache` with `_projVer = _wmv` and `_projAspect` set
  to the exact aspect the render task will request. `_viewVer`/`_vpVer` are
  invalidated (`-1`) so the view and view-projection caches recompose from the new
  pose + injected projection.

**Aspect float-identity invariant:** `getProjectionMatrix` only returns the
injected cache when `_projAspect === aspect`. The render task computes
`aspect = (rt._width / rt._height) * (viewport.width / viewport.height)`.
`updateXrCameraForView` MUST replicate this **exact float expression with the same
operand order** so the values are bit-identical; otherwise the cache misses and a
wrong symmetric perspective is recomputed.

### Eager render targets
`rt._eager = true` makes `buildRenderTarget` a no-op (the compositor owns the
textures) and `disposeRenderTarget` a no-op (so XR-owned textures are never
destroyed). Each frame the loop refreshes `rt._colorTexture/_colorView/
_depthTexture/_depthView/_width/_height` from the `XRGPUSubImage`.

### Per-frame attachment swap
`executePass` only re-reads the color view from the RT each frame when
`cfg.rt === eng.scRT`. XR RTs are not `scRT`, so the loop manually updates
`task._colorAttachment.view` **and**
`task._renderPassDescriptor.depthStencilAttachment.view` every frame (the
compositor returns fresh `GPUTexture`s from a double/triple-buffered swap chain).

### Depth handling
The single eager RT carries **both** color and depth (its descriptor has `format`
+ `dFormat`); there is no separate `config.depth`. A `config.depth` combined with
`_eager` would force `loadOp: "load"`, but XR needs `"clear"` each frame. With
depth on the color RT and no `config.depth`, `_depthLoadOp` is undefined and
defaults to `"clear"`. Correct.

---

## Pipeline Configuration

XR introduces **no new pipelines**. `Renderable.bind(engine, targetSignature)`
already resolves/builds pipelines per target signature, so the scene's
renderables render correctly into the XR target's formats (e.g.
`rgba8unorm` / `depth24plus` / 1 sample) — exactly how shadow maps and RTTs target
their own signatures today. Bind group 0 (scene UBO) is task-owned, so each eye's
task carries its own per-eye view/projection.

---

## Shader Logic

None. XR reuses the scene's existing materials and shaders unchanged; only the
group(0) scene UBO contents (per-eye view/projection/eye-position) differ, and
those come from the injected camera caches.

---

## State Machine / Lifecycle

```
enterXr(scene, opts)
  ├─ guard: isWebXrPresent() && isWebGpuXrSupported()  → throw if missing
  ├─ navigator.xr.requestSession(mode, { requiredFeatures: ["webgpu", ...] })
  ├─ binding = new XRGPUBinding(session, device)
  ├─ layer = binding.createProjectionLayer({ colorFormat, depthStencilFormat })
  ├─ session.updateRenderState({ layers: [layer] })
  ├─ referenceSpace = requestReferenceSpace("local-floor") ?? "local"
  ├─ stopEngine(engine)                 // hand the render loop to XR
  ├─ input = createXrInputManager(...) | null
  ├─ if AR: save scene.clearColor, force alpha = 0 (passthrough)
  ├─ session.addEventListener("end", () => cleanup(ctx), { once: true })
  └─ session.requestAnimationFrame(onXrFrame)

onXrFrame(ctx, time, frame)             // per XRFrame
  ├─ reschedule next frame
  ├─ pose = frame.getViewerPose(referenceSpace)
  ├─ if input: updateXrInputPoses(...)
  ├─ options.onFrame?.(...)
  ├─ if !pose: return (skip render, keep loop alive)
  ├─ encoder = device.createCommandEncoder(); set eng._currentEncoder/_currentDelta
  ├─ scene._update()                    // ONCE: animations, pre-passes, uniform updaters
  ├─ for each view:
  │    ├─ subImage = binding.getViewSubImage(layer, view)
  │    ├─ ensureUnit(i, eye)            // lazily build RT + camera + task
  │    ├─ refresh eager RT views + task attachment views
  │    ├─ task.record() once
  │    ├─ updateXrCameraForView(camera, view, texW, texH, viewport)
  │    └─ task.execute()
  ├─ device.queue.submit([encoder.finish()])
  └─ restore prev encoder/delta

exitXr(ctx) → session.end() → "end" event → cleanup(ctx)

cleanup(ctx)                            // idempotent
  ├─ cancel rAF
  ├─ disposeXrInputManager(input)
  ├─ dispose per-eye tasks; clear units
  ├─ restore saved clearColor (AR)
  ├─ options.onEnd?.()
  └─ startEngine(engine)                // resume the canvas loop
```

**AR passthrough.** `scene.clearColor.a` is forced to 0 for the session so the
real world shows through; the original is restored on end. This is invisible to
the canvas because the canvas loop is stopped while in XR.

---

## Babylon.js Equivalence Map

| Babylon.js (`dev/core/src/XR/`)        | Babylon Lite (`xr/`)                                  |
| -------------------------------------- | ----------------------------------------------------- |
| `WebXRSessionManager`                  | `enterXr` / `exitXr` / `XrSessionContext`             |
| `WebXRExperienceHelper` (enter/exit)   | `enterXr` / `exitXr` (no default-experience UI)       |
| `WebXRCamera` + rig cameras            | `XrCamera` (one per eye) + matrix-cache injection     |
| `WebXRRenderTarget` / WebGL layer      | eager `RenderTarget` + `XRGPUBinding` projection layer|
| `WebXRInput` / `WebXRInputSource`      | `XrInputManager` / `XrInputSource`                    |
| `WebXRSessionManager.isSessionSupportedAsync` | `isXrSessionSupported`                         |
| WebGL binding (`XRWebGLBinding`)       | **WebGPU binding** (`XRGPUBinding`) — draft           |

Difference of substance: Babylon.js XR runs on WebGL2 with `XRWebGLBinding`;
Babylon Lite is WebGPU-exclusive and targets the draft `XRGPUBinding`, so the
per-view loop pulls `GPUTexture`s from `getViewSubImage` rather than binding a
framebuffer.

---

## Dependencies

- `engine/engine.ts` — `startEngine` / `stopEngine`, `EngineContext` internals
  (`_device`, `_currentEncoder`, `_currentDelta`).
- `engine/render-target.ts` — `createRenderTarget` + eager-RT semantics.
- `frame-graph/render-task.ts` — `createRenderTask`, `record`/`execute`/`dispose`,
  `_colorAttachment`, `_renderPassDescriptor`.
- `camera/camera.ts` — `Camera` interface + matrix-cache contract (read, not modified).
- `scene/scene-core.ts` — `SceneContext`, `scene._update`, `scene.clearColor`,
  `scene.surface.engine`.
- Dev dependency `@types/webxr` for the standard WebXR DOM types; draft binding
  types are ambient in `webxr-webgpu.d.ts`.

No module-level side effects (Pillar: no module-level `new Map()` etc.); all state
lives on the returned context objects.

---

## Test Specification

Unit tests (mocked, `tests/lite/unit/xr/`) — run with `pnpm test:unit`. Parity/
perf tests are not applicable (no XR golden reference).

- **`xr-support.test.ts`** — `isWebXrPresent` / `isWebGpuXrSupported` /
  `isXrSessionSupported` across present/absent `navigator.xr` + `XRGPUBinding`;
  never-throws-on-rejection guarantee.
- **`xr-camera.test.ts`** — view matrix is the inverse of the eye pose; projection
  injected verbatim for the render task's exact aspect; view-projection = proj ×
  view; aspect bit-identity with the render-task formula; version bump per update.
- **`xr-input.test.ts`** — seed from `session.inputSources`; add/remove on
  `inputsourceschange`; no duplicate add; select/squeeze flag toggles + callbacks;
  ignores untracked sources; pose updates + untracked fallbacks; dispose removes
  listeners.
- **`xr-session.test.ts`** — throws without WebXR / without binding; full enter →
  one-frame stereo render (two cameras, two passes, one submit) → exit; pose-less
  frame keeps the loop alive without rendering; AR forces/restores `clearColor.a`;
  VR leaves clear color untouched; input manager created/disposed; onFrame/onEnd
  callbacks fire.

Lab demo: `lab/lite/xr.html` + `lab/lite/src/xr.ts` — a small scene with
**Enter VR / Enter AR / Exit** buttons that feature-detect via
`isXrSessionSupported` and report "WebGPU XR not yet supported" gracefully. State
is exposed on `window.__xrDemo`.

---

## File Manifest

| File                                  | Responsibility                                          |
| ------------------------------------- | ------------------------------------------------------- |
| `xr/webxr-webgpu.d.ts`                | Ambient declarations for the draft WebGPU XR binding.   |
| `xr/xr-support.ts`                    | Feature detection (`XrSessionMode`, the three checks).  |
| `xr/xr-camera.ts`                     | `XrCamera` + per-view view/projection cache injection.  |
| `xr/xr-input.ts`                      | Input-source tracking + select/squeeze events.          |
| `xr/xr-session.ts`                    | Session lifecycle + per-frame stereo render loop.       |
| `tests/lite/unit/xr/*.test.ts`        | Mocked unit tests (support, camera, input, session).    |
| `lab/lite/xr.html` + `src/xr.ts`      | Gated, gracefully-degrading lab demo.                   |
