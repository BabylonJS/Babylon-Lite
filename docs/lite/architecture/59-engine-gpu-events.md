# Module: Engine GPU events and capabilities

> Package path: `packages/babylon-lite/src/engine/engine-gpu-events.ts`

## Purpose

Expose uncaptured GPU errors, device loss, enabled features, and current-device limits without
requiring applications to retrieve the engine's raw `GPUDevice`. Subscriptions are opt-in and
follow devices installed by device-lost recovery.

## Public API Surface

```typescript
export type EngineGpuErrorCallback = (error: GPUError) => void;
export type EngineDeviceLostCallback = (info: GPUDeviceLostInfo) => void;

export function onEngineGpuError(
    engine: EngineContext,
    callback: EngineGpuErrorCallback
): () => void;

export function onEngineDeviceLost(
    engine: EngineContext,
    callback: EngineDeviceLostCallback
): () => void;

export function getEngineLimits(engine: EngineContext): GPUSupportedLimits;
export function hasEngineFeature(engine: EngineContext, feature: GPUFeatureName): boolean;
```

Both subscriptions return an unsubscribe function. Error callbacks receive validation,
out-of-memory, or internal errors not handled by an application error scope. Device-loss callbacks
also receive intentional destruction (`info.reason === "destroyed"`). Capability functions read
the engine's current device, not the adapter or a cached previous device.

## Internal Architecture

The first subscription lazily creates `engine._gpuEvents` with `_errors` and `_lost` callback
sets, `_device = null`, and one stable `_onError` handler. It installs the opaque
`engine._attachGpuEvents` seam. There is no module-level registry, allocation, or registration.

Attachment is idempotent for the same device. On replacement, remove the error handler from the
previous device, remember the new device, add its `"uncapturederror"` handler, and subscribe to
its `lost` promise. A loss continuation compares its captured device with the registry's current
device before notifying subscribers; a late notification from an obsolete device is ignored.

The error handler forwards the event's `error` through the error callback set. Each loss
continuation iterates the loss callback set. Unsubscribe removes its callback from the corresponding
set; repeated removal is harmless. Callback identity follows normal `Set` semantics.

## Pipeline Configuration

None. Error subscriptions do not replace WebGPU error scopes and do not modify pipeline behavior.
Feature queries report only features actually enabled on the current device.

## Shader Logic

None.

## State Machine / Lifecycle

1. With no subscriptions, registry and recovery seam are absent.
2. First subscription initializes the registry and attaches the current device.
3. Additional subscriptions share the handler and loss continuation.
4. Unsubscribe removes callback membership without resetting the registry.
5. Recovery installs a replacement device and calls `_attachGpuEvents?.(engine)` before rebuilding
   resources. The registry detaches the obsolete device and follows the replacement.

Device destruction is reported as device loss rather than silently filtered out. Promise and
event delivery are asynchronous; callback exceptions are not swallowed by this module.

## Babylon.js Equivalence Map

These functions provide the application-facing role of engine error and device-loss observables.
Lite uses standalone subscription functions and lazy plain state instead of observable methods
attached to the engine.

## Dependencies

`engine.ts` supplies type-only registry/seam fields. `device-lost-recovery-run.ts` calls the
optional seam after device replacement. The root `index.ts` re-exports the four functions and
two callback types; no package subpath export is added.

## Test Specification

`tests/lite/unit/engine-gpu-events.test.ts` covers uncaptured error forwarding, unsubscribe,
intentional device destruction, one attachment per device, replacement-device delivery,
obsolete-device loss suppression, current-device limits/features, and opt-in state.
The replacement-device regression awaits manual recovery, then disables automatic recovery before
resolving either device's loss promise. A `finally` block disables recovery even if an assertion
fails, preventing additional asynchronous recovery from outliving the test's global stubs.
No test must require an actual GPU to verify callback membership and device-generation behavior.

## File Manifest

- `engine/engine-gpu-events.ts`: subscriptions and capability queries.
- `engine/engine.ts`: type-only registry and optional attachment seam.
- `engine/device-lost-recovery-run.ts`: replacement-device attachment.
- `tests/lite/unit/engine-gpu-events.test.ts`: event/capability coverage.
