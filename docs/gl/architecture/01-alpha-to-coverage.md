# Module: Lite-GL Alpha-to-Coverage

> Package path: `packages/babylon-lite-gl/src/alpha-to-coverage.ts`

## Purpose

Provide optional WebGL2 `SAMPLE_ALPHA_TO_COVERAGE` state for multisampled draw framebuffers. The module mirrors Babylon.js's opt-in ThinEngine extension while preserving Lite-GL's function-based API, context-owned state discipline, context-loss behavior, and zero bytes for consumers that do not import the feature.

## Public API Surface

```typescript
/** Enable or disable SAMPLE_ALPHA_TO_COVERAGE. Cached and context-loss safe. */
export function setAlphaToCoverage(engine: GLEngineContext, enabled: boolean): void;

/** Return the requested state. Defaults to false. */
export function getAlphaToCoverage(engine: GLEngineContext): boolean;

/** Return the current draw framebuffer's sample count, normalized to at least 1. */
export function getCurrentSampleCount(engine: GLEngineContext): number;
```

All functions use the engine-first convention and are explicitly re-exported from the package root. No alpha-to-coverage create option is added: importing these standalone functions is the feature gate.

## Internal Architecture

The module owns a lazy `WeakMap<GLEngineContext, AlphaToCoverageState>`; module import allocates nothing. Each state record contains:

```typescript
interface AlphaToCoverageState {
    enabled: boolean; // requested state
    applied: boolean | null; // state known to be applied to the live context
    restore: () => void; // registered once with onContextRestored
}
```

`setAlphaToCoverage` updates the requested value, early-outs if the same value is already applied, and otherwise calls exactly one of:

```typescript
engine.gl.enable(engine.gl.SAMPLE_ALPHA_TO_COVERAGE);
engine.gl.disable(engine.gl.SAMPLE_ALPHA_TO_COVERAGE);
```

Lost/disposed contexts receive no GL call. A lost context still retains the requested value; the registered restore callback invalidates `applied` and reapplies the request after the package's normal effect/texture/target/buffer restoration completes. Engine disposal clears the engine's restore callbacks, and the weak key permits collection without explicit module cleanup.

The first state allocation also appends a callback to the engine's lazily allocated `_stateCacheInvalidators` list. When a host invalidates Lite-GL's shared cache after touching raw GL state, that callback resets `applied` to `null`; the next same-value setter therefore reissues `gl.enable`/`gl.disable` instead of trusting stale optional state. Engines that use no such optional feature never allocate the list.

This state is independent of `GLState.rs`: no other Lite-GL module mutates `SAMPLE_ALPHA_TO_COVERAGE`, so adding it to the always-present deferred-state array/dispatcher would charge every consumer for a niche feature. Keeping the state entirely in the optional module gives non-users literally zero runtime bytes and zero hot-path checks.

`getCurrentSampleCount` reads `gl.SAMPLES` for the currently bound draw framebuffer and returns `Math.max(1, value)`. A non-multisampled framebuffer commonly reports `0`, which is normalized to Babylon's single-sample value `1`.

## Pipeline / GL Configuration

Alpha-to-coverage is enabled only by the explicit setter. The module does not alter blending, depth writes, color masks, or shaders. The effective coverage behavior is provided by WebGL2 when the active draw framebuffer has more than one sample.

Recommended depth-writing use:

1. request an antialiased canvas (`createGLEngine(canvas, { antialias: true, depth: true })`) or bind a multisampled target;
2. disable blending / use replacement color writes;
3. enable depth testing and depth writes;
4. output fractional fragment alpha;
5. call `setAlphaToCoverage(engine, getCurrentSampleCount(engine) > 1)` around the affected draw scope;
6. restore the prior state afterward.

## State Machine / Lifecycle

```text
unseen engine (reported false)
    -> set(true)  -> gl.enable, requested/applied true
    -> set(true)  -> no-op
    -> context lost -> no GL calls, request retained
    -> context restored -> gl.enable reapplied
    -> host wipeGLStateCache -> applied unknown; next setter reapplies
    -> set(false) -> gl.disable, requested/applied false
    -> dispose -> subsequent setters are no-ops
```

## Babylon.js Equivalence Map

| Babylon.js ThinEngine extension     | Lite-GL                              |
| ----------------------------------- | ------------------------------------ |
| `engine.setAlphaToCoverage(enable)` | `setAlphaToCoverage(engine, enable)` |
| `engine.getAlphaToCoverage()`       | `getAlphaToCoverage(engine)`         |
| `engine.currentSampleCount`         | `getCurrentSampleCount(engine)`      |
| `gl.SAMPLE_ALPHA_TO_COVERAGE`       | same WebGL2 capability               |
| extension-local cached state        | optional-module lazy WeakMap state   |

## Dependencies

- `GLEngineContext` (type).
- `onContextRestored` from the core context module.
- WebGL2 core; no extension object and no external dependency.

## Test Specification

1. Focused mock-GL tests assert one exact enable/disable call and duplicate-call elision.
2. Tests assert lost/disposed safety and reapplication after context restoration.
3. Tests assert `gl.SAMPLES` normalization (`0 -> 1`, `4 -> 4`).
4. Tests assert `wipeGLStateCache` invalidates the optional applied-state cache.
5. GL Scene 17 renders matching red/green overlap panels with A2C disabled/enabled. Four stable interior patches permit at most one channel-value difference from the ThinEngine golden; full-image MAD is informational because raster-edge sample patterns differ by backend.
6. Existing GL scenes remain below unchanged size ceilings; the feature module appears only in Scene 17's bundle.

## File Manifest

- `packages/babylon-lite-gl/src/alpha-to-coverage.ts` — complete optional implementation.
- `packages/babylon-lite-gl/src/index.ts` — explicit named exports.
- `tests/gl/unit/alpha-to-coverage.test.ts` — focused state/lifecycle tests.
- `lab/gl/src/{scene17,babylon-ref-scene17}.ts` plus HTML/config/reference assets — visual parity scene.
