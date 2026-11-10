# Module: Device Context

> Package path: `packages/babylon-lite/src/engine/`

## Purpose

Separate canvas-independent WebGPU acquisition from engine initialization. A small
bootstrap bundle can call `createDevice` while downloading application code, then
pass the resulting context to the engine that will own it. No native GPU handles are public.

## Public API Surface

```typescript
interface DeviceOptions {
    requiredLimits?: Record<string, GPUSize64 | undefined>;
}
interface DeviceContext {} // opaque branded handle
function createDevice(options?: DeviceOptions): Promise<DeviceContext>;
function disposeDevice(device: DeviceContext): void;
interface EngineDeviceOptions extends Omit<EngineOptions, "requiredLimits" | "device"> {
    device: DeviceContext;
    requiredLimits?: never;
    requiredFeatures?: never;
}
function createEngine(canvas: RenderCanvas, options: EngineDeviceOptions): Promise<EngineContext>;
function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext>;
```

`EngineContext.device` exposes its device context. Legacy `EngineOptions` forbids a
device property and retains its existing device limits and surface/precision options.
`createEngineWithFeatures` retains its existing signature and its internal feature
resolver. Explicit features are deliberately not a `DeviceOptions` field, and the context
exposes no feature/limit capability snapshot; both would add bytes to every
`createEngine` bundle. Capabilities remain queryable through the existing engine helpers.

## Internal Architecture

The device module has no runtime dependency on engines, canvases, rendering, or recovery.
It contains adapter-option installation (retaining the existing XR enabler), the
opportunistic feature list, the feature-resolver hook installed only by
`createEngineWithFeatures`, and acquisition. Bundles that never install either hook let
the bundler fold the hook checks away. `disposeDevice` lives in
its own module so only callers that import it pay for it.

Internal fields hold the native device, the creation options, and a `_claimed` flag.
All internal fields use `@internal` and disappear from emitted public declarations.
An erased unique-symbol brand prevents native devices and structural lookalikes from
satisfying the public context type. Engine `_device` remains an internal alias used by
existing GPU subsystems.

Features are Lite's existing seven opportunistic features, or the installed resolver's
selection. Power preference stays fixed at `high-performance`, as before.

## Pipeline Configuration

Unchanged. Surface creation configures its canvas with the context's native device.

## Shader Logic

Unchanged.

## State Machine / Lifecycle

A device context backs exactly one engine. `createEngine` without `device` calls
`createDevice` itself, forwarding its options object whole (it carries `requiredLimits`
and, for `createEngineWithFeatures`, the resolver's `requiredFeatures`), so both paths
share one acquisition implementation. With `device`, the engine skips acquisition; engine-level
feature/limit options are rejected by the `EngineDeviceOptions` type rather than at
runtime.

`createEngine` rejects a context already owned by an engine or disposed before configuring
the canvas. It claims the context only after initialization succeeds. If initialization
fails, a supplied context remains the caller's responsibility: it can be disposed with
`disposeDevice` or used in another attempt. `disposeDevice` is idempotent and a no-op
after an engine owns the context; `disposeEngine` destroys the owned device.

Failure does not automatically unconfigure a partially initialized canvas or destroy an
internally acquired device, matching the existing engine-initialization behavior. A configured
canvas can retain a device until the canvas is unconfigured, reconfigured, or released.
Dropping an unused context without disposing it leaves reclamation to garbage collection
once no references remain.

Device loss is coordinated only when recovery is enabled, exactly as before the device
context existed: the engine requests a replacement using its enabled features, the
context's original limits, and any storage-recovery limits. On
success it updates both `engine._device` and the context's native device, so
`engine.device` stays current. Without recovery, passing a device lost while
the application bundle downloaded behaves like `createEngine` racing a loss: the engine
is created on a lost device.

## Babylon.js Equivalence Map

`createEngine` remains the convenient full initialization path. `createDevice` is a
Lite-specific plain-state acquisition step.

## Dependencies

Device acquisition: browser WebGPU and erased engine type imports only.
Recovery: existing opt-in recovery, storage recovery, and engine lifecycle.

## Test Specification

- Device-only creation never touches a canvas or imports engine runtime code.
- Opportunistic feature selection, installed adapter options, absent adapter,
  adapter/device rejection, and limits.
- An engine uses a supplied device without further adapter/device requests and
  destroys it on disposal; `createEngine` without a device acquires one through
  `createDevice` with the engine options object.
- A context already owned by an engine or disposed with `disposeDevice` is rejected
  before the canvas is configured.
- Initialization failure leaves a supplied device available for disposal or retry;
  rejecting an already-owned context leaves its original engine's device intact.
- Engine-level acquisition options, including non-literal `requiredFeatures`, and
  `createDevice({ requiredFeatures })` are rejected by emitted type probes.
- Recovery reuses the context's limits and updates the context.

## File Manifest

- `device.ts`: context, acquisition, ownership claim, adapter-option and feature-resolver hooks.
- `device-dispose.ts`: teardown for a context that never reached an engine.
- `engine.ts`, `engine-dispose.ts`: acquisition, ownership, and destruction.
- `device-lost-recovery-run.ts`: recovery reads creation options and updates the context.
- `compute/compute-engine-features.ts`, `compute/compute-uniform-f16.ts`,
  `xr/xr-adapter.ts`: feature/adapter selection integration.
- `index.ts`: root-only exports.
- Focused unit/build tests and the engine architecture document.
