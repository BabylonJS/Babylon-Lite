# Module: Animation Parity Testing — Deterministic Frame Sync
> Scope: `lab/`, `scripts/capture-golden.ts`, `tests/lite/parity/`

## Purpose

Animated scenes (skeleton, morph targets) must be captured at the exact same
animation frame in both the Babylon.js reference and Babylon Lite. Without
synchronisation, frame-rate differences cause different poses and produce
false parity failures. This module documents the deterministic frame
synchronisation protocol that eliminates that class of flake.

---

## Problem

Each machine/GPU renders at a different native frame rate. Babylon.js adapts
its animation timestep to the real delta time, so a 144 Hz monitor and a
60 Hz monitor will show a different pose after the same wall-clock duration.
Screenshot comparisons therefore produce spurious diffs unless both sides
agree on **which animation frame** to capture and use **identical timesteps**
to reach it.

---

## Solution: Freeze-at-Frame-N + Constant Timestep

The protocol has two parts:

1. **Constant timestep** — both engines advance animations by exactly 16 ms
   per frame, regardless of the real delta time.
2. **Frame freeze** — at a predetermined frame count (e.g. frame 300), both
   engines pause all animations but continue rendering. A DOM signal tells
   the test harness that the frozen frame is ready for capture.

---

## Constant Timestep (Both Sides)

### BJS Reference (`babylon-ref-sceneN.html`)

```javascript
engine.getDeltaTime = function () { return 16; };
scene.useConstantAnimationDeltaTime = true;
```

### Lite (`sceneN.ts`)

```typescript
engine._fixedDeltaMs = 16.0;
```

Both sides now advance at a fixed 16 ms / frame. Animation state after N
frames is fully deterministic.

---

## Frame Freeze

At a specific frame count both engines pause animation but keep rendering.

### BJS Reference

```javascript
let frameCount = 0;
scene.registerBeforeRender(() => {
    frameCount++;
    if (frameCount === 300) {
        scene.animationGroups.forEach(g => g.pause());
        canvas.dataset.animationFrozen = 'true';
    }
});
```

### Lite (gated behind `?freeze` query param)

```typescript
if (new URLSearchParams(location.search).has('freeze')) {
    let frameCount = 0;
    engine._beforeRender.push(() => {
        frameCount++;
        if (frameCount === 300) {
            engine.pauseAnimations();
            canvas.dataset.animationFrozen = 'true';
        }
    });
}
```

The `?freeze` query-param gate keeps interactive browsing unaffected — only
tests and the golden-capture script append it.

---

## Signal Protocol

`canvas.dataset.animationFrozen = 'true'` is the DOM signal consumed by:

1. **Golden capture** (`scripts/capture-golden.ts`) — waits for this signal
   before taking the reference screenshot.
2. **Parity tests** (`tests/lite/parity/sceneN-*.spec.ts`) — waits for the signal
   on the Lite page before pixel-comparing against the golden.

---

## Parity Test Pattern

```typescript
test('Scene N — Animated model matches reference', async ({ page }) => {
    // Load Lite scene with freeze param
    await page.goto('/sceneN.html?freeze');
    await page.waitForFunction(
        () => document.querySelector('canvas')?.dataset.ready === 'true',
        { timeout: 30_000 },
    );
    // Wait for exact animation frame
    await page.waitForFunction(
        () => document.querySelector('canvas')?.dataset.animationFrozen === 'true',
        { timeout: 30_000 },
    );
    // Screenshot and compare against golden
    const screenshot = await page.screenshot({ /* … */ });
    // … pixel comparison …
});
```

---

## Golden Capture

`scripts/capture-golden.ts` is a CLI tool that captures golden reference PNGs:

```bash
pnpm exec tsx scripts/capture-golden.ts 5   # Capture scene 5 golden
```

For animated scenes it:

1. Opens the BJS reference HTML.
2. Waits for `canvas.dataset.animationFrozen === 'true'`.
3. Takes screenshot → `reference/lite/sceneN-*/babylon-ref-golden.png`.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Exact frame (`=== N`), not `>= N`** | Both BJS and Lite must freeze at the identical animation pose. An inequality would allow off-by-one drift. |
| **Constant 16 ms delta** | Without this, BJS adapts to actual frame rate, making poses non-deterministic across different hardware. |
| **Query-param gating (`?freeze`)** | Interactive browsing stays unaffected. Only tests and golden capture append the param. |
| **Frame 300** | Late enough that all assets are loaded and animations are mid-cycle (interesting poses), early enough for fast tests (~5 s at 60 fps). |

---

## File Manifest

| File | Role |
|------|------|
| `lab/lite/babylon-ref-scene5.html` | BJS reference with frame sync |
| `lab/lite/babylon-ref-scene7.html` | BJS reference with frame sync |
| `lab/lite/src/lite/scene5.ts` | Lite scene with freeze support |
| `lab/lite/src/lite/scene7.ts` | Lite scene with freeze support |
| `scripts/capture-golden.ts` | Golden-capture CLI |
| `tests/lite/parity/scene5-alien.spec.ts` | Animated parity test |
| `tests/lite/parity/scene7-chibirex.spec.ts` | Animated parity test |

---

## Applying to New Animated Scenes

When adding a new animated scene:

1. **BJS ref** — add `getDeltaTime = () => 16`,
   `useConstantAnimationDeltaTime`, frame counter, freeze + signal.
2. **Lite scene** — add `_fixedDeltaMs = 16`, freeze behind `?freeze` param,
   signal.
3. **Parity test** — wait for both `ready` and `animationFrozen` signals
   before screenshotting.
4. **capture-golden.ts** — add scene to the registry with `animated: true`
   and the freeze frame count.
