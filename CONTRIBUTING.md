# Contributing to Babylon Lite

## Adding a New Scene to the Manual Lab

Each scene demonstrates a specific rendering feature and serves as both a visual demo and an automated regression test. Follow these steps to add **Scene N**.

### 1. Choose an ID and Slug

Pick the next available scene number (e.g., `23`) and a descriptive slug:
- ID: `23`
- Slug: `scene23-my-feature`

### 2. Create the Lite Scene

**`apps/manual-lab/sceneN.html`**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Babylon Lite — Scene N: My Feature</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    canvas { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <canvas id="renderCanvas"></canvas>
  <script src="/loader.js"></script>
  <script type="module" src="/src/lite/sceneN.ts"></script>
</body>
</html>
```

**`apps/manual-lab/src/lite/sceneN.ts`**
```typescript
import { createEngine, createSceneContext, createDefaultCamera, attachControl } from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // --- Set up your scene here ---

    const cam = createDefaultCamera(scene);
    attachControl(cam, canvas, scene);

    await engine.start(scene);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
```

> **Tip:** Study existing scenes in `apps/manual-lab/src/lite/` for patterns. If a similar feature already exists (e.g., DDS skybox in scene14, animation in scene7), reuse its approach.

### 3. Create the Babylon.js Reference

**`apps/manual-lab/babylon-ref-sceneN.html`**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Babylon.js Reference — Scene N: My Feature</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    canvas { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <canvas id="renderCanvas"></canvas>
  <script type="module" src="/src/bjs/sceneN.ts"></script>
</body>
</html>
```

**`apps/manual-lab/src/bjs/sceneN.ts`** — Implement the same scene using `@babylonjs/core` APIs. This is the pixel-perfect reference. Set `canvas.dataset.ready = "true"` once rendered.

### 4. Vite Config (Auto-Detected)

HTML files in `apps/manual-lab/` are **auto-detected** by `vite.config.ts` — no manual entry needed.

### 5. Capture the Golden Reference

Run the BJS reference page and capture a screenshot:

```bash
# Start the dev server
pnpm dev:lab

# In another terminal, capture the golden
npx tsx scripts/capture-golden.ts --scene N
```

Or manually screenshot the canvas at `http://localhost:5174/babylon-ref-sceneN.html` and save as:
```
reference/sceneN-my-feature/babylon-ref-golden.png
```

Also copy as thumbnail:
```
apps/manual-lab/public/thumbnails/sceneN.png
```

### 6. Add Scene Config

Add an entry to **`scene-config.json`**:

```json
{
    "id": 23,
    "slug": "scene23-my-feature",
    "name": "Scene 23 — My Feature",
    "maxMad": 0.01,
    "maxRawKB": 60,
    "maxGzipKB": 22,
    "description": "Brief description of what the scene demonstrates.",
    "tags": ["pbr", "procedural"]
}
```

- `maxMad` — Maximum Mean Absolute Difference allowed (start tight, loosen only with approval)
- `maxRawKB` / `maxGzipKB` — Bundle size ceilings (never raise without explicit approval)

### 7. Create the Parity Test

**`tests/parity/scenes/sceneN-my-feature.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";
import * as path from "path";
import { captureGolden, compareImages, getSceneConfig } from "../compare-utils";

const sceneConfig = getSceneConfig(23);
const REFERENCE_DIR = path.resolve(__dirname, "../../../reference/scene23-my-feature");
const GOLDEN_REF = path.join(REFERENCE_DIR, "babylon-ref-golden.png");

test("Scene 23 — My Feature matches Babylon.js reference", async ({ page }) => {
    const browser = page.context().browser()!;
    await captureGolden(browser, { sceneId: 23 });

    await page.goto("/scene23.html");
    await page.waitForFunction(
        () => document.querySelector("canvas")?.dataset.ready === "true",
        { timeout: 20_000 }
    );
    await page.waitForTimeout(500);

    const screenshotPath = path.join(REFERENCE_DIR, "test-actual.png");
    await page.locator("canvas").screenshot({ path: screenshotPath });

    const full = compareImages(screenshotPath, GOLDEN_REF);
    console.log(`Full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}`);

    expect(full.mad, `Full image MAD should be ≤ ${sceneConfig.maxMad}`)
        .toBeLessThanOrEqual(sceneConfig.maxMad);
});
```

### 8. Run and Verify

```bash
# Run the parity test for your scene
npx playwright test tests/parity/scenes/sceneN-my-feature.spec.ts

# Run the full suite to check for regressions
pnpm test
```

### Checklist

- [ ] `apps/manual-lab/sceneN.html` created
- [ ] `apps/manual-lab/src/lite/sceneN.ts` created
- [ ] `apps/manual-lab/babylon-ref-sceneN.html` created
- [ ] `apps/manual-lab/src/bjs/sceneN.ts` created
- [ ] `reference/sceneN-slug/babylon-ref-golden.png` captured
- [ ] `apps/manual-lab/public/thumbnails/sceneN.png` copied
- [ ] `scene-config.json` entry added
- [ ] `tests/parity/scenes/sceneN-slug.spec.ts` created
- [ ] Parity test passes locally
- [ ] All existing tests still pass (`pnpm test`)

---

## Adding Plumbing Tests

Plumbing tests validate engine internals (dispose, material-swap, etc.) using Playwright + WebGPU.

1. Create a test page in `apps/manual-lab/` (HTML + TS)
2. Create the spec in `tests/plumbing/`
3. Run: `npx playwright test tests/plumbing/my-test.spec.ts`

> **Note:** CI uses Chrome's SwiftShader Vulkan backend for WebGPU — no real GPU needed.

## Adding Unit Tests

For pure logic (shader composition, math) that doesn't need a browser:

1. Create `tests/unit/my-feature.test.ts`
2. Use vitest: `describe`, `it`, `expect`
3. Run: `npx vitest run`

## Code Quality

- Run `pnpm lint` before submitting — must produce **0 errors, 0 warnings**
- Prefix intentionally unused variables with `_` (e.g., `_light`, `_cam`)
- Use `import type` for type-only imports
- Never raise bundle-size ceilings or MAD thresholds without explicit approval
