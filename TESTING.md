# Testing

Babylon Lite uses four categories of automated tests, all orchestrated by
Playwright and/or Vitest. An Azure Pipelines CI pipeline runs five parallel
jobs on every PR targeting `master`.

---

## Quick Reference

| Command                  | What it runs                                             |
| ------------------------ | -------------------------------------------------------- |
| `pnpm test`              | Build bundles → parity tests (local)                     |
| `pnpm test:parity`       | Parity pixel-diff tests (local Chrome)                   |
| `pnpm test:parity-cloud` | Parity tests on BrowserStack (macOS Chrome, real WebGPU) |
| `pnpm test:perf`         | Performance regression tests (local)                     |
| `pnpm test:perf-cloud`   | Performance regression on BrowserStack                   |
| `pnpm test:bundle-size`  | Bundle size ceiling checks                               |
| `pnpm test:bundle-delta` | Bundle size delta vs committed baseline                  |
| `pnpm test:all`          | Parity + perf tests (local)                              |
| `pnpm test:watch`        | Vitest in watch mode (unit tests)                        |
| `pnpm lint`              | ESLint + TypeScript type-check                           |

---

## 1. Unit Tests

**Runner:** Vitest  
**Location:** `tests/unit/`  
**Config:** `vitest.config.ts`

Standard unit tests for core logic (shader composer, shader integration, etc.).

```sh
pnpm test:watch   # interactive
npx vitest run     # single run
```

---

## 2. Plumbing Tests

**Runner:** Playwright  
**Location:** `tests/plumbing/`

Browser-based integration tests that exercise engine lifecycle:

- `dispose.spec.ts` — resource cleanup
- `material-swap.spec.ts` — hot material replacement
- `memory-leak.spec.ts` — allocation tracking
- `picking.spec.ts` — GPU picking

```sh
npx playwright test tests/plumbing/
```

---

## 3. Parity Tests (Pixel Comparison)

**Runner:** Playwright  
**Location:** `tests/parity/scenes/` (25 scene spec files)  
**Configs:**

- Local: `playwright.config.ts`
- Cloud: `config/playwright.parity-cloud.config.ts`

Compares screenshots of Babylon Lite rendering against golden reference images
(BJS screenshots stored in `reference/`). Uses Mean Absolute Difference (MAD)
as the error metric; thresholds are defined per-scene in `scene-config.json`.

### How it works

1. Opens the Lite bundle page (`bundle-scene{N}.html`)
2. Waits for `canvas[data-ready="true"]`
3. Takes a screenshot
4. Compares pixel-by-pixel against the golden reference
5. Asserts MAD ≤ scene threshold

### Running locally

```sh
pnpm build:bundle-scenes
pnpm test:parity
```

### Running on BrowserStack

Requires `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` (set in
`.env.local` or as environment variables).

```sh
pnpm build:bundle-scenes
pnpm test:parity-cloud
```

### Golden References

Golden images are committed in `reference/` and compared against Lite renders.
`captureGolden()` skips BJS page capture when the golden file already exists
on disk, which significantly speeds up test runs.

To force recapture of all golden references (e.g., after a Babylon.js update):

```sh
RECAPTURE_GOLDEN=true pnpm test:parity
```

### Timeouts

Canvas-ready timeouts are set per-scene based on model complexity:

| Scenes           | Timeout |
| ---------------- | ------- |
| Most scenes      | 60 s    |
| Hill Valley, KTX | 90 s    |
| Sponza           | 120 s   |

These higher values account for model downloads through the BrowserStack
tunnel.

---

## 4. Performance Regression Tests

**Runner:** Playwright  
**Location:** `tests/perf/perf-regression.spec.ts`  
**Configs:**

- Local: `playwright.perf.config.ts`
- Cloud: `config/playwright.perf-cloud.config.ts`

Measures CPU + GPU frame time by intercepting the engine's RAF-based render
loop at runtime, then compares current Lite bundles against a baseline built
from the previous release.

### How it works

1. **Runtime injection** via `page.addInitScript()` — no scene modifications
   needed:
    - Monkey-patches `requestAnimationFrame` to capture the render callback
    - Monkey-patches `GPUQueue.prototype.submit` to capture the GPU queue
    - Exposes `window.__perfStop()` to halt the RAF loop
    - Exposes `window.__perfRender()` to call render + `await queue.onSubmittedWorkDone()`

2. **Single-page measurement** — all runs happen on one page load (one model
   download) to eliminate network variance:
    - Each run: warmup frames → measured frames
    - Measured frames use `performance.now()` around `__perfRender()` for true
      CPU+GPU cost
    - Trimmed mean (drops top/bottom 10%) per run
    - Median across all runs = final result

3. **Assertion** — only the trimmed mean average is asserted (p95 is logged
   but not asserted, as it's too noisy at sub-ms frame times)

### Environment Variables

| Variable              | Default | Description                                       |
| --------------------- | ------- | ------------------------------------------------- |
| `PERF_REGRESSION_PCT` | `5`     | Maximum allowed regression % (trimmed mean)       |
| `PERF_FRAMES`         | `300`   | Measured frames per run                           |
| `PERF_RUNS`           | `5`     | Number of runs per version (takes median)         |
| `PERF_WARMUP`         | `60`    | Warmup frames before each measurement run         |
| `PERF_SCENES`         | all     | Comma-separated scene IDs to test (e.g., `1,5,9`) |

### Prerequisites

```sh
pnpm build:bundle-scenes       # build current bundles
pnpm build:perf-baseline        # build baseline from last release tag
```

The baseline script (`scripts/build-perf-baseline.ts`) uses a git worktree to
check out the last `v*` release tag (or `origin/master` if no tags exist),
builds its bundles, and copies them to `lab/public/bundle-baseline/`.

### Running locally

```sh
pnpm build:bundle-scenes
pnpm build:perf-baseline
pnpm test:perf
```

### Running on BrowserStack

```sh
pnpm build:bundle-scenes
pnpm build:perf-baseline
pnpm test:perf-cloud
```

### Tuning for stability

If tests are flaky on noisy VMs, increase warmup and frame count:

```sh
PERF_WARMUP=120 PERF_FRAMES=500 pnpm test:perf-cloud
```

---

## 5. Bundle Size Checks

**Runner:** Playwright  
**Location:** `tests/parity/bundle-size.spec.ts`, `tests/parity/bundle-size-delta.spec.ts`

Two complementary checks:

1. **Ceiling checks** — each scene bundle must stay under `maxRawKB` /
   `maxGzipKB` defined in `scene-config.json`
2. **Delta checks** — compares current bundle sizes against a committed
   baseline (`baselines/bundle-size.json`), fails if any scene grows beyond a
   threshold

```sh
pnpm build:bundle-scenes
pnpm test:bundle-size       # ceiling checks
pnpm test:bundle-delta      # delta vs baseline
```

### Environment Variables

| Variable           | Default | Description                          |
| ------------------ | ------- | ------------------------------------ |
| `BUNDLE_DELTA_PCT` | —       | Maximum allowed bundle size growth % |

To update the baseline after a release:

```sh
pnpm build:bundle-scenes && pnpm snapshot:bundle-baseline
```

---

## BrowserStack Configuration

**Config file:** `config/browserstack.yml`

| Setting           | Value                                |
| ----------------- | ------------------------------------ |
| Platform          | macOS Sonoma                         |
| Browser           | Chrome latest                        |
| Parallel sessions | 5                                    |
| Local tunnel      | Enabled (tests hit `localhost:5174`) |

Credentials are read from environment variables:

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

For local development, add these to `.env.local` (git-ignored).

---

## Azure Pipelines CI

**Config:** `azure-pipelines.yml`  
**Trigger:** PRs targeting `master`

Five parallel jobs:

| Job                 | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| **Unit Tests**      | Vitest unit tests + Playwright plumbing tests          |
| **Bundle Size**     | Ceiling checks + delta vs baseline                     |
| **Perf Regression** | Current vs baseline on BrowserStack (macOS Chrome)     |
| **Parity (Cloud)**  | Pixel-diff on BrowserStack (macOS Chrome, real WebGPU) |
| **Lint**            | ESLint + TypeScript `--noEmit` type-check              |

### Required Pipeline Variables (Secrets)

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

### Optional Pipeline Variables

- `PERF_REGRESSION_PCT` — override regression threshold
- `PERF_FRAMES` — override measured frames per run
- `PERF_RUNS` — override number of runs per version
- `PERF_WARMUP` — override warmup frames per run
- `BUNDLE_DELTA_PCT` — override bundle delta threshold

### Test Reporting

Both cloud test suites (perf and parity) produce:

- **JUnit XML** — consumed by Azure DevOps `PublishTestResults@2` and
  displayed in the pipeline's **Tests** tab with pass/fail counts, durations,
  and error messages
- **HTML report** — interactive Playwright report with error details,
  screenshots, and traces

Report locations after a run:

| Suite  | JUnit XML                       | HTML Report                             |
| ------ | ------------------------------- | --------------------------------------- |
| Parity | `test-results/parity-junit.xml` | `test-results/parity-report/index.html` |
| Perf   | `test-results/perf-junit.xml`   | `test-results/perf-report/index.html`   |

To view the HTML report locally:

```sh
npx playwright show-report test-results/parity-report
npx playwright show-report test-results/perf-report
```

In CI, test artifacts (including the HTML report) are uploaded as pipeline
artifacts on every run and can be downloaded from the build summary.

---

## Scene Configuration

All 25 test scenes are defined in `scene-config.json` at the repo root. Each
entry specifies:

```json
{
    "id": 1,
    "slug": "boombox",
    "name": "BoomBox",
    "maxMad": 1.5,
    "maxRegionMad": 3.0,
    "maxRawKB": 200,
    "maxGzipKB": 80
}
```

- `maxMad` — parity MAD threshold (whole image)
- `maxRegionMad` — parity MAD threshold (focus region, if defined)
- `maxRawKB` / `maxGzipKB` — bundle size ceilings

---

## Environment Variables Reference

| Variable                  | Scope  | Default | Description                             |
| ------------------------- | ------ | ------- | --------------------------------------- |
| `PERF_REGRESSION_PCT`     | Perf   | `5`     | Max allowed regression %                |
| `PERF_FRAMES`             | Perf   | `300`   | Measured frames per run                 |
| `PERF_RUNS`               | Perf   | `5`     | Runs per version (takes median)         |
| `PERF_WARMUP`             | Perf   | `60`    | Warmup frames before each run           |
| `PERF_SCENES`             | Perf   | all     | Comma-separated scene IDs               |
| `BUNDLE_DELTA_PCT`        | Bundle | —       | Max allowed bundle size growth %        |
| `RECAPTURE_GOLDEN`        | Parity | —       | Set to `true` to force golden recapture |
| `BROWSERSTACK_USERNAME`   | Cloud  | —       | BrowserStack credentials                |
| `BROWSERSTACK_ACCESS_KEY` | Cloud  | —       | BrowserStack credentials                |
