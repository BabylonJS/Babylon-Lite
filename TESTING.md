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
**Location:** `tests/lite/unit/`  
**Config:** `vitest.config.ts`

Standard unit tests for core logic (shader composer, shader integration, etc.).

```sh
pnpm test:watch        # interactive
pnpm exec vitest run   # single run
```

---

## 2. Plumbing Tests

**Runner:** Playwright  
**Location:** `tests/lite/plumbing/`

Browser-based integration tests that exercise engine lifecycle:

- `dispose.spec.ts` — resource cleanup
- `material-swap.spec.ts` — hot material replacement
- `memory-leak.spec.ts` — allocation tracking
- `picking.spec.ts` — GPU picking

```sh
pnpm exec playwright test tests/lite/plumbing/
```

---

## 3. Parity Tests (Pixel Comparison)

**Runner:** Playwright  
**Location:** `tests/lite/parity/scenes/` (one spec file per scene)  
**Configs:**

- Local: `playwright.config.ts`
- Cloud: `config/playwright.parity-cloud.config.ts`

Compares screenshots of Babylon Lite rendering against golden reference images
(BJS screenshots stored in `reference/lite/`). Uses Mean Absolute Difference (MAD)
as the error metric; thresholds are defined per-scene in `scene-config.json`.

### How it works

1. Opens the Lite scene page (`sceneN.html`)
2. Waits for `canvas[data-ready="true"]`
3. Takes a screenshot
4. Compares pixel-by-pixel against the committed golden reference
5. Asserts MAD ≤ scene threshold

### Running locally

```sh
pnpm build:bundle-scenes
pnpm test:parity
```

### Running on BrowserStack

Requires `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` (set in
`.env.local` or as environment variables). Azure Pipelines gets these from the
`BabylonJS-BrowserStack` variable group.

```sh
pnpm build:bundle-scenes
pnpm test:parity-cloud
```

In CI, parity runs on BrowserStack over a direct CDP connection
(`connectOptions.wsEndpoint`, no SDK) and is **sharded across parallel cloud
sessions**: `scripts/browserstack-wait.sh` grabs up to `BSTACK_SESSIONS_REQUIRED`
sessions (falling back to fewer when the plan is busy) and exports `CIWORKERS` so
Playwright shards to match. Pages are served from a public, build-isolated static
site (`pnpm build:lab-site` + upload) and loaded directly via `PARITY_BASE_URL` —
no Local tunnel. Run `pnpm test:parity` (local Chrome) for day-to-day dev.

### Golden References

Every parity scene **must have a committed golden** at
`reference/lite/<scene-slug>/babylon-ref-golden.png`. The golden is a Babylon.js
reference render — the ground truth the Lite render is pixel-diffed against — and
it is **tracked in git** (the `.gitignore` filters out transient `babylon-ref-*`
artifacts but explicitly allows `babylon-ref-golden.png`, so no `git add -f` is
needed).

**Why a committed golden matters (performance).** `captureGolden()` skips capture
when the golden already exists on disk, so the test renders Lite once and finishes
in ~6 s. When the golden is **missing**, the harness falls back to rendering a full
Babylon.js reference page **live on every run** — a second engine boot plus asset
download over the network — which pushes the test to 30–70 s and adds flakiness.
A single missing golden makes that scene roughly **10× slower** in CI. This is the
difference between the parity job finishing quickly and taking hours.

**Capturing / recapturing.** Goldens must be captured on the **same WebGPU
renderer** they are compared against in CI — BrowserStack macOS (Metal). Run the
capture on a **Mac** so the local render matches; Windows/Linux CI agents lack
WebGPU and cannot capture:

```sh
# macOS, real WebGPU — recapture ALL goldens (e.g. after a Babylon.js bump)
RECAPTURE_GOLDEN=true pnpm test:parity
git add 'reference/lite/**/babylon-ref-golden.png'
```

```sh
# capture a SINGLE new scene's golden
RECAPTURE_GOLDEN=true pnpm exec playwright test tests/lite/parity/scenes/sceneN-<slug>.spec.ts
```

After capturing, open the PNG and confirm it looks correct before committing.

> **Only commit goldens that actually changed.** Re-rendering WebGPU is not
> bit-deterministic — anti-aliasing, floating-point order, GPU/driver, and frame
> timing make every recapture produce slightly different bytes. A blanket
> `RECAPTURE_GOLDEN=true pnpm test:parity` therefore rewrites **every** golden,
> even ones with no visual change, churning large binary PNGs for nothing. Before
> committing a recapture, drop the noise-only diffs and keep only goldens that are
> **new** or have a **real visual change** (a diff above the scene's `maxMad`, or
> an intended scene/Babylon.js change). A quick filter:
>
> ```sh
> # restore any golden whose change is within tolerance / not intended
> git checkout -- reference/lite/<scene-slug>/babylon-ref-golden.png
> ```
>
> Normal CI runs never overwrite an existing golden (`captureGolden()` only
> recaptures when `RECAPTURE_GOLDEN` is set), so this churn only ever comes from a
> manual blanket recapture being committed wholesale.

### Adding a new scene

When you add a parity scene you **must generate and commit its golden in the same
PR** (see `GUIDANCE.md` §2 for the full new-scene checklist). The short version:

1. Add the scene, its `tests/lite/parity/scenes/sceneN-<slug>.spec.ts` spec, and a
   `scene-config.json` entry (`id`, `slug`, `name`, `maxMad`).
2. On a Mac, capture the golden:
   `RECAPTURE_GOLDEN=true pnpm exec playwright test tests/lite/parity/scenes/sceneN-<slug>.spec.ts`
3. Verify `reference/lite/sceneN-<slug>/babylon-ref-golden.png` was written and
   looks right.
4. Commit the golden alongside the scene. **Never** rely on CI to capture it — an
   uncommitted golden silently triggers the slow live-capture path on every run.

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
**Location:** `tests/lite/perf/perf-regression.spec.ts`  
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
**Location:** `tests/lite/parity/bundle-size.spec.ts`

Each scene bundle must stay under `maxRawKB` defined in `scene-config.json`
(gzip size is shown for reference but not enforced).

```sh
pnpm build:bundle-scenes
pnpm test:bundle-size
```

---

## BrowserStack Configuration

Two jobs use BrowserStack with **different connection models**:

| Job             | Connection                              | Parallelism                  | Tunnel |
| --------------- | --------------------------------------- | ---------------------------- | ------ |
| Parity (Cloud)  | Direct CDP (`connectOptions.wsEndpoint`) | Sharded (`CIWORKERS` sessions) | None   |
| Perf Regression | `browserstack-node-sdk` + `browserstack.yml` | Serial (1 session)           | Local  |

**Parity (Cloud)** connects straight to a remote Chrome over CDP — no SDK and no
`browserstack.yml`. Capabilities (macOS Sonoma, Chrome latest, real WebGPU) are
built in `config/playwright.parity-cloud.config.ts`. The ~198 specs are sharded
across parallel cloud sessions; `scripts/browserstack-wait.sh` grabs sessions and
exports `CIWORKERS`. Pages load from a public static site (`PARITY_BASE_URL`), so
no Local tunnel is used.

**Perf Regression** still uses `browserstack-node-sdk` with `config/browserstack.yml`
(`browserstackLocal: true`) because it compares current vs baseline on a single
shared VM reached through the Local tunnel (`localhost:5174`).

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

### Required Pipeline Variable Groups

Azure Pipelines uses `BabylonJS-BrowserStack` for shared BrowserStack
credentials:

- `BROWSERSTACK_USERNAME`
- `BROWSERSTACK_ACCESS_KEY`

It uses `BabylonJS-Deployment` for deployment server credentials used when
uploading failed Playwright HTML reports:

- `DEPLOYMENT_SERVER`
- `DEPLOY_TOKEN`

### Required Report Upload Variables

The failed-test report upload template also expects these pipeline variables:

- `DEPLOY_ENDPOINT_UPLOAD`
- `STORAGE_ACCOUNT`
- `SERVE_DOMAIN`

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
pnpm exec playwright show-report test-results/parity-report
pnpm exec playwright show-report test-results/perf-report
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
    "maxRawKB": 200
}
```

- `maxMad` — parity MAD threshold (whole image)
- `maxRegionMad` — parity MAD threshold (focus region, if defined)
- `maxRawKB` — bundle raw size ceiling (gzip is informational only)

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
| `PARITY_REQUIRE_GOLDEN`   | Parity | —       | Set to `true` to fail (not live-capture) when a scene's golden is missing |
| `BROWSERSTACK_USERNAME`   | Cloud  | —       | BrowserStack credentials                |
| `BROWSERSTACK_ACCESS_KEY` | Cloud  | —       | BrowserStack credentials                |
